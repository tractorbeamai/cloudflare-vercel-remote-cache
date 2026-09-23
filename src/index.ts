import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticate, fail } from "./auth";

type App = { Bindings: Env; Variables: { teamId: string } };
const app = new Hono<App>();
const routes = new Hono<App>();
const encoder = new TextEncoder();
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
  const url = new URL(c.req.url);
  c.set("teamId", identity.teamId);
  const ci = c.req.header("x-artifact-client-ci");
  const interactive = c.req.header("x-artifact-client-interactive");
  if (
    (ci && ci.length > 50) ||
    (interactive !== undefined && !["0", "1"].includes(interactive))
  ) {
    fail(400, "invalid_header", "Invalid client metadata");
  }
  const limited = await c.env.REQUEST_LIMITER.limit({
    key: `${identity.teamId}:${identity.subject}`,
  });
  if (!limited.success) fail(429, "rate_limited", "Request limit exceeded");
  const path = url.pathname.replace(/^\/v8(?=\/)/, "");
  const methods =
    path === "/artifacts/status"
      ? ["GET"]
      : ["/artifacts", "/artifacts/events"].includes(path)
        ? ["POST"]
        : /^\/artifacts\/[^/]+$/.test(path)
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
function key(teamId: string, value: string): string {
  return `${teamId}/${value}`;
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

routes.get("/artifacts/status", (c) => c.json({ status: "enabled" }));
routes.post("/artifacts/events", async (c) => {
  if (!eventSchema.safeParse(await jsonBody(c.req.raw)).success)
    fail(400, "invalid_events", "Invalid cache events");
  // Acknowledge telemetry without storing potentially sensitive build information.
  return c.json({});
});
routes.post("/artifacts", async (c) => {
  const parsed = querySchema.safeParse(await jsonBody(c.req.raw));
  if (!parsed.success) fail(400, "invalid_query", "Invalid artifact query");
  const entries: [string, unknown][] = [];
  // Bound fan-out and resource usage, including repeated hashes.
  for (const value of new Set(parsed.data.hashes)) {
    const object = await c.env.ARTIFACTS.head(key(c.get("teamId"), value));
    entries.push([
      value,
      object
        ? {
            size: object.size,
            taskDurationMs: Number(
              object.customMetadata?.["x-artifact-duration"] ?? 0,
            ),
            tag: object.customMetadata?.["x-artifact-tag"],
          }
        : null,
    ]);
  }
  return c.json(Object.fromEntries(entries));
});
routes.put("/artifacts/:hash", async (c) => {
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
  let metadataBytes = 0;
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
    metadataBytes +=
      encoder.encode(name).byteLength + encoder.encode(v).byteLength;
  }
  if (metadataBytes > 2048)
    fail(400, "invalid_metadata", "Metadata exceeds R2 limit");
  // Atomic first-writer-wins: retries succeed without changing stored bytes or
  // metadata, even when writers race for the same hash.
  await c.env.ARTIFACTS.put(
    key(c.get("teamId"), value),
    c.req.raw.body ?? new Uint8Array(),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata,
    },
  );
  const prefix = c.req.path.startsWith("/v8/") ? "/v8" : "";
  const url = new URL(`${prefix}/artifacts/${value}`, c.req.url);
  url.searchParams.set("teamId", c.get("teamId"));
  return c.json({ urls: [url.toString()] }, 202);
});
routes.on(["GET", "HEAD"], "/artifacts/:hash", async (c) => {
  const value = hash(c.req.param("hash"));
  if (c.req.method === "HEAD") {
    const object = await c.env.ARTIFACTS.head(key(c.get("teamId"), value));
    if (!object) fail(404, "not_found", "Artifact not found");
    return new Response(null, { headers: headers(object) });
  }
  const object = await c.env.ARTIFACTS.get(key(c.get("teamId"), value));
  if (!object) fail(404, "not_found", "Artifact not found");
  return new Response(object.body, { headers: headers(object) });
});

app.route("/", routes);
app.route("/v8", routes);

export default app;
