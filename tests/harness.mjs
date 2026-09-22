import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readConfig } from "../scripts/config.mjs";

// All fixtures run the same Worker; only identities and storage need isolation.
const fixture = Promise.all([
  readConfig(),
  build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
  }),
]);

export async function startHarness(overrides = {}, options = {}) {
  const [config, compiled] = await fixture;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  const issuer = "https://test.cloudflareaccess.com";
  const sign = (claims = {}) =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.iss ?? issuer)
      .setSubject(claims.sub ?? "test-user")
      .setAudience(claims.aud ?? "caddi-audience")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "1h")
      .sign(privateKey);
  const bindings = {
    ...config.vars,
    ACCESS_ISSUER: issuer,
    PROJECT_ACCESS: {
      caddi: "caddi-audience",
      carlyle: "carlyle-audience",
    },
    ...overrides,
  };
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        config: {
          name: config.name,
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          cache: config.cache,
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: compiled.outputFiles[0].text,
              },
            },
          },
          env: {
            ...Object.fromEntries(
              Object.entries(bindings).map(([k, value]) => [
                k,
                { type: "json", value },
              ]),
            ),
            ARTIFACTS: { type: "r2", name: "test-artifacts" },
            REQUEST_LIMITER: {
              type: "rate-limit",
              namespace: "test-limit",
              simple: { limit: options.rateLimit ?? 100000, period: 60 },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: async (request) => {
              if (request.url !== `${issuer}/cdn-cgi/access/certs`)
                throw new Error(`Unexpected outbound URL: ${request.url}`);
              return Response.json({ keys: [jwk] });
            },
          },
        },
      },
    ],
  });
  const url = (await mf.ready).origin;
  const token = await sign();
  return {
    url,
    token,
    sign,
    close: () => mf.dispose(),
    request: (path, init = {}) => {
      const target = new URL(path, url);
      if (
        !target.searchParams.has("teamId") &&
        !target.searchParams.has("slug")
      )
        target.searchParams.set("teamId", "caddi");
      return fetch(target, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
    },
  };
}
