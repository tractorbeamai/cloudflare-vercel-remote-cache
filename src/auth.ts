import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";

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
      { code, message, error: { code, message } },
      { status, headers: { "Cache-Control": "private, no-store" } },
    ),
  });
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<{ subject: string; writable: boolean }> {
  const issuer = env.ACCESS_ISSUER;
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !env.ACCESS_READ_AUD ||
    !env.ACCESS_WRITE_AUD
  ) {
    fail(503, "auth_unconfigured", "Access configuration is required");
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
  try {
    const { payload } = await jwtVerify(token, keyCache.keys, {
      issuer,
      audience: [env.ACCESS_READ_AUD, env.ACCESS_WRITE_AUD],
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    const subject = payload.sub
      ? `user:${payload.sub}`
      : payload.sub === "" &&
          typeof payload.common_name === "string" &&
          payload.common_name.endsWith(".access")
        ? `service:${payload.common_name}`
        : undefined;
    if (!subject) fail(401, "unauthorized", "Invalid Access identity");
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return { subject, writable: audiences.includes(env.ACCESS_WRITE_AUD) };
  } catch {
    fail(401, "unauthorized", "A valid Access token is required");
  }
}
