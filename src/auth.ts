import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export const teamIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const projectAccessSchema = z.record(teamIdSchema, z.string().min(1));

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
  const projects = projectAccessSchema.safeParse(env.PROJECT_ACCESS);
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !projects.success ||
    !Object.keys(projects.data).length
  ) {
    fail(503, "auth_unconfigured", "Project Access configuration is required");
  }
  const audiences = Object.values(projects.data);
  if (new Set(audiences).size !== audiences.length)
    fail(503, "auth_unconfigured", "Access audiences must be project-specific");
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
    audience: audiences,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub"],
  }).catch(() => fail(401, "unauthorized", "A valid Access token is required"));
  const subject = payload.sub
    ? `user:${payload.sub}`
    : payload.sub === "" &&
        typeof payload.common_name === "string" &&
        payload.common_name.endsWith(".access")
      ? `service:${payload.common_name}`
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
  const access = Object.hasOwn(projects.data, teamId)
    ? projects.data[teamId]
    : undefined;
  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : [payload.aud];
  if (!access || !tokenAudiences.includes(access))
    fail(403, "forbidden", "Project is not authorized");
  return { subject, teamId };
}
