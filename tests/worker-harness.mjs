import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.ts";

const keys = new Map();

export function installJwksFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const key = keys.get(url.origin);
    if (url.pathname === "/cdn-cgi/access/certs" && key)
      return Response.json({ keys: [key] });
    throw new Error(`Unexpected outbound URL: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
    keys.clear();
  };
}

export async function clearArtifacts() {
  let cursor;
  do {
    const page = await env.ARTIFACTS.list({ cursor });
    if (page.objects.length)
      await env.ARTIFACTS.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function startHarness(overrides = {}, options = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const issuer = `https://test-${crypto.randomUUID()}.cloudflareaccess.com`;
  keys.set(issuer, {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  });
  const sign = (claims = {}) =>
    new SignJWT({
      type: "app",
      custom: { groups: ["Project: CADDi"] },
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.iss ?? issuer)
      .setSubject(claims.sub ?? "test-user")
      .setAudience(claims.aud ?? "cache-audience")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "1h")
      .sign(privateKey);
  const bindings = {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: "cache-audience",
    MAX_ARTIFACT_BYTES: 67108864,
    PROJECTS: { caddi: "Project: CADDi", carlyle: "Project: Carlyle" },
    SERVICE_PROJECTS: {
      "test-client.access": ["caddi"],
      "caddi-ci.access": ["caddi"],
    },
    REQUEST_LIMITER: options.rateLimit
      ? env.REQUEST_LIMITER_LOW
      : env.REQUEST_LIMITER,
    ...overrides,
  };
  const token = await sign();
  const rawRequest = (route, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body != null && !headers.has("Content-Length"))
      headers.set("Content-Length", String(new Blob([init.body]).size));
    return worker.fetch(
      new Request(new URL(route, "https://cache.test"), {
        ...init,
        headers,
      }),
      bindings,
      createExecutionContext(),
    );
  };
  return {
    token,
    sign,
    close: () => keys.delete(issuer),
    rawRequest,
    request: (route, init = {}) => {
      const target = new URL(route, "https://cache.test");
      if (
        !target.searchParams.has("teamId") &&
        !target.searchParams.has("slug")
      )
        target.searchParams.set("teamId", "caddi");
      return rawRequest(target.toString(), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
    },
  };
}
