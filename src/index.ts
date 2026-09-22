import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticate, fail } from "./auth";

type App = { Bindings: Env; Variables: { writable: boolean } };
const app = new Hono<App>();
const hashSchema = z
  .string()
  .regex(/^[a-fA-F0-9]+$/)
  .min(1)
  .max(256);
const eventSchema = z
  .array(
    z.object({
      sessionId: z
        .string()
        .regex(
          /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/,
        ),
      source: z.enum(["LOCAL", "REMOTE"]),
      event: z.enum(["HIT", "MISS"]),
      hash: z.string().refine((value) => [...value].length <= 256),
      duration: z.number().int().nonnegative().optional(),
    }),
  )
  .max(128);
const querySchema = z.object({ hashes: z.array(hashSchema).max(128) });
const metadataNames = [
  "x-artifact-duration",
  "x-artifact-tag",
  "x-artifact-sha",
  "x-artifact-dirty-hash",
] as const;

app.onError((error) => {
  if (error instanceof HTTPException) return error.getResponse();
  // Do not log request headers, tokens, artifact contents, or raw exceptions.
  console.error(JSON.stringify({ event: "request_failed", type: error.name }));
  return Response.json(
    { code: "internal_error", message: "Request failed" },
    {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
});
app.notFound(() => fail(404, "not_found", "Route not found"));

app.use("*", async (c, next) => {
  const identity = await authenticate(c.req.raw, c.env);
  c.set("writable", identity.writable);
  const url = new URL(c.req.url);
  for (const [param, allowed] of [
    ["teamId", c.env.TEAM_ID],
    ["slug", c.env.TEAM_SLUG],
  ] as const) {
    const values = url.searchParams.getAll(param);
    if (values.length > 1) fail(400, "invalid_query", "Repeated team selector");
    if (
      values.length &&
      !(param === "slug" ? [allowed, c.env.TEAM_ID] : [allowed]).includes(
        values[0],
      )
    )
      fail(403, "forbidden", "Team is not authorized");
  }
  const ci = c.req.header("x-artifact-client-ci");
  const interactive = c.req.header("x-artifact-client-interactive");
  if (
    (ci && ci.length > 50) ||
    (interactive !== undefined && !["0", "1"].includes(interactive))
  ) {
    fail(400, "invalid_header", "Invalid client metadata");
  }
  const limited = await c.env.REQUEST_LIMITER.limit({ key: identity.subject });
  if (!limited.success) fail(429, "rate_limited", "Request limit exceeded");
  const methods =
    url.pathname === "/v8/artifacts/status"
      ? ["GET"]
      : ["/v8/artifacts", "/v8/artifacts/events"].includes(url.pathname)
        ? ["POST"]
        : /^\/v8\/artifacts\/[^/]+$/.test(url.pathname)
          ? ["GET", "HEAD", "PUT"]
          : undefined;
  if (methods && !methods.includes(c.req.method)) {
    return Response.json(
      { code: "method_not_allowed", message: "Unsupported method" },
      {
        status: 405,
        headers: {
          Allow: methods.join(", "),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  await next();
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
});

function hash(value: string): string {
  const result = hashSchema.safeParse(value);
  if (!result.success)
    fail(
      400,
      "invalid_hash",
      "Expected a hexadecimal artifact hash of 1–256 characters",
    );
  return result.data;
}
function key(env: Env, value: string): string {
  // The namespace is configuration, never a caller-controlled path component.
  return `${env.TEAM_ID}/${value}`;
}
function headers(object: R2Object): Headers {
  const result = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(object.size),
  });
  for (const name of metadataNames) {
    const value = object.customMetadata?.[name];
    if (value !== undefined) result.set(name, value);
  }
  return result;
}
async function jsonBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    fail(400, "invalid_content_type", "Expected application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) fail(400, "invalid_body", "Expected JSON");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      fail(413, "body_too_large", "JSON exceeds 64 KiB");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    fail(400, "invalid_body", "Invalid JSON");
  }
}

app.get("/v8/artifacts/status", (c) => c.json({ status: "enabled" }));
app.post("/v8/artifacts/events", async (c) => {
  if (!eventSchema.safeParse(await jsonBody(c.req.raw)).success)
    fail(400, "invalid_events", "Invalid cache events");
  // Acknowledge telemetry without storing potentially sensitive build information.
  return c.json({});
});
app.post("/v8/artifacts", async (c) => {
  const parsed = querySchema.safeParse(await jsonBody(c.req.raw));
  if (!parsed.success) fail(400, "invalid_query", "Invalid artifact query");
  const entries: [string, unknown][] = [];
  // Bound fan-out and resource usage, including repeated hashes.
  for (const value of new Set(parsed.data.hashes)) {
    const object = await c.env.ARTIFACTS.head(key(c.env, value));
    entries.push([
      value,
      object
        ? {
            size: object.size,
            taskDurationMs: Number(
              object.customMetadata?.["x-artifact-duration"] ?? 0,
            ),
            ...(object.customMetadata?.["x-artifact-tag"] !== undefined
              ? { tag: object.customMetadata["x-artifact-tag"] }
              : {}),
          }
        : null,
    ]);
  }
  return c.json(Object.fromEntries(entries));
});
app.put("/v8/artifacts/:hash", async (c) => {
  if (!c.get("writable")) fail(403, "forbidden", "Write access required");
  const value = hash(c.req.param("hash"));
  if (
    c.req.header("Content-Type")?.split(";")[0].trim() !==
    "application/octet-stream"
  ) {
    fail(400, "invalid_content_type", "Expected application/octet-stream");
  }
  const rawLength = c.req.header("Content-Length");
  if (
    !rawLength ||
    !/^\d+$/.test(rawLength) ||
    !Number.isSafeInteger(Number(rawLength))
  ) {
    fail(400, "invalid_length", "Valid Content-Length required");
  }
  const length = Number(rawLength);
  if (length > c.env.MAX_ARTIFACT_BYTES)
    fail(413, "artifact_too_large", "Artifact exceeds configured limit");
  const customMetadata: Record<string, string> = {};
  for (const name of metadataNames) {
    const v = c.req.header(name);
    if (v === undefined) continue;
    if (v.length > (name === "x-artifact-tag" ? 600 : 128))
      fail(400, "invalid_metadata", "Metadata is too long");
    if (
      name === "x-artifact-duration" &&
      (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
    ) {
      fail(400, "invalid_duration", "Duration must be a nonnegative integer");
    }
    customMetadata[name] = v;
  }
  const metadataBytes = Object.entries(customMetadata).reduce(
    (total, [name, v]) =>
      total +
      new TextEncoder().encode(name).byteLength +
      new TextEncoder().encode(v).byteLength,
    0,
  );
  if (metadataBytes > 2048)
    fail(400, "invalid_metadata", "Metadata exceeds R2 limit");
  // Atomic first-writer-wins: retries succeed without changing stored bytes or
  // metadata. Cached copies stay valid even when writers race for the same hash.
  await c.env.ARTIFACTS.put(
    key(c.env, value),
    c.req.raw.body ?? new Uint8Array(),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata,
    },
  );
  const url = new URL(`/v8/artifacts/${value}`, c.req.url);
  url.searchParams.set("teamId", c.env.TEAM_ID);
  return c.json({ urls: [url.toString()] }, 202);
});
app.on(["GET", "HEAD"], "/v8/artifacts/:hash", async (c) => {
  const value = hash(c.req.param("hash"));
  if (c.req.method === "HEAD") {
    const object = await c.env.ARTIFACTS.head(key(c.env, value));
    if (!object) fail(404, "not_found", "Artifact not found");
    return new Response(null, { headers: headers(object) });
  }
  // Construct a fresh internal request: client cookies, authorization, ranges,
  // conditionals and arbitrary query parameters must not influence shared cache.
  return c.executionCtx.exports.ArtifactReader.fetch(
    new Request(`https://artifacts.internal/${value}`),
  );
});

export class ArtifactReader extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const value = new URL(request.url).pathname.slice(1);
    if (request.method !== "GET" || !hashSchema.safeParse(value).success) {
      return new Response(null, {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const object = await this.env.ARTIFACTS.get(key(this.env, value));
    if (!object)
      return Response.json(
        { code: "not_found", message: "Artifact not found" },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        },
      );
    const responseHeaders = headers(object);
    responseHeaders.set(
      "Cache-Control",
      `public, max-age=${this.env.CACHE_TTL_SECONDS}`,
    );
    return new Response(object.body, { headers: responseHeaders });
  }
}
export default app;
