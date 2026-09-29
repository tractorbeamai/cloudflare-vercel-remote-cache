import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const teamIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const projectsSchema = z.record(
  teamIdSchema,
  z.string().startsWith("Project: ").max(128),
);
const serviceProjectsSchema = z.record(
  z.string().min(1).max(256),
  z.array(teamIdSchema).min(1),
);
const groupsSchema = z.object({
  groups: z.array(z.string().startsWith("Project: ").max(128)).max(64),
});

// Only public verification keys are cached. Credentials and identities are never
// shared between requests. A config change replaces the resolver.
let keyCache:
  { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

export function fail(
  status: 400 | 401 | 403 | 404 | 405 | 413 | 429 | 503,
  code: string,
  message: string,
): never {
  throw new HTTPException(status, {
    res: Response.json(
      { code, message },
      { status, headers: { "Cache-Control": "private, no-store" } },
    ),
  });
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<{ subject: string; teamId: string }> {
  const issuer = env.ACCESS_ISSUER;
  const projects = projectsSchema.safeParse(env.PROJECTS);
  const services = serviceProjectsSchema.safeParse(env.SERVICE_PROJECTS);
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !env.ACCESS_AUD ||
    !services.success ||
    !projects.success ||
    !Object.keys(projects.data).length
  ) {
    fail(503, "auth_unconfigured", "Project Access configuration is required");
  }
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const token = assertion ?? bearer;
  if (!token || token.length > 16384)
    fail(401, "unauthorized", "A valid Access token is required");
  if (!keyCache || keyCache.issuer !== issuer) {
    keyCache = {
      issuer,
      keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }
  const { payload } = await jwtVerify(token, keyCache.keys, {
    issuer,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "type"],
  }).catch(() => fail(401, "unauthorized", "A valid Access token is required"));
  if (payload.type !== "app")
    fail(401, "unauthorized", "An Access application token is required");
  const serviceId =
    payload.sub === "" &&
    typeof payload.common_name === "string" &&
    payload.common_name.length > 0
      ? payload.common_name
      : undefined;
  const subject = serviceId
    ? `service:${serviceId}`
    : payload.sub
      ? `user:${payload.sub}`
      : undefined;
  if (!subject) fail(401, "unauthorized", "Invalid Access identity");

  const query = new URL(request.url).searchParams;
  const ids = query.getAll("teamId");
  const slugs = query.getAll("slug");
  if (ids.length > 1 || slugs.length > 1)
    fail(400, "invalid_query", "Repeated team selector");
  if (ids.length && slugs.length && ids[0] !== slugs[0])
    fail(400, "invalid_query", "Team selectors must identify the same project");
  const teamId = ids[0] ?? slugs[0];
  if (!teamId || !teamIdSchema.safeParse(teamId).success)
    fail(400, "invalid_query", "A project teamId or slug is required");
  const group = Object.hasOwn(projects.data, teamId)
    ? projects.data[teamId]
    : undefined;
  if (!group) fail(403, "forbidden", "Project is not enabled");

  if (serviceId) {
    const allowed = Object.hasOwn(services.data, serviceId)
      ? services.data[serviceId]
      : [];
    if (!allowed.includes(teamId))
      fail(403, "forbidden", "Service is not authorized for this project");
  } else {
    // Access may omit custom claims when they exceed its cookie budget. Never
    // fall back to admission alone or trust caller-provided group headers.
    const custom = groupsSchema.safeParse(payload.custom);
    if (
      !custom.success ||
      new TextEncoder().encode(JSON.stringify(payload.custom)).length > 700 ||
      !custom.data.groups.includes(group)
    )
      fail(403, "forbidden", "Project membership is required");
  }
  return { subject, teamId };
}
