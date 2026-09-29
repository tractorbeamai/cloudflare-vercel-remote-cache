# Cloudflare-native Turborepo remote cache

Hono on a nonprod Cloudflare Worker with private R2 storage and one nonprod
Access application for identity issuance. Corporate owns the `tractorbeam.tools`
DNS zone; exact project hostnames are served by nonprod through Cloudflare for
SaaS.

```mermaid
flowchart LR
  Client[Developer or CI] --> Access[Nonprod Access: issue application JWT]
  Access --> Turbo[Turbo Bearer token]
  Turbo --> Worker[Worker: verify signed identity and project]
  Worker --> R2[Private R2: project/hash]
```

## Authorization

The nonprod [infra stack](https://github.com/tractorbeamai/infra/tree/main/cloudflare/nonprod)
manages exact project hostnames and one Worker-level Access application. Only
Constellation is enabled initially; setting `remote_cache: true` on another
project in `infra/data/projects.json` adds its hostname and Okta group to the
token-issuance policy after the staged rollout. The nonprod Okta integration forwards a filtered
`Project: ` groups claim. The Worker verifies the application JWT's signature,
issuer, audience, expiry and identity, then requires the exact project group in
its signed `custom.groups` claim. Missing, malformed and oversized claims deny
access. Caller-supplied group headers never grant permission.

`teamId` is an enabled project key such as `constellation`; `slug` is an
alternative selector. At least one is required, and duplicates or conflicting
selectors are rejected. The hostname does not grant project permission. Reads
and writes use the same group check. R2 keys include the authorized project, so
identical hashes in different projects remain independent.

`vars.PROJECTS` in [wrangler.jsonc](wrangler.jsonc) must match the applied
`remote_cache_project_groups` Terraform output. Deploy the Worker after every
project flag or group-name change. **Disabling a project is complete only after
the Worker map is updated.** Someone who also belongs to an enabled project can
still pass Access admission with a stale Worker map. The shared identity config
bounds all registered project group names below 700 bytes and 64 groups, leaving
headroom under Cloudflare's approximate 1 KB custom-claim limit.

Access service tokens do not have human group memberships. The nonprod infra
stack creates a Constellation-only Service Auth policy and stores its credential
in AWS Secrets Manager for Constellation's RWX vault OIDC role. After applying
infra, copy `remote_cache_constellation_ci_client_id` into `SERVICE_PROJECTS` in
`wrangler.jsonc` as `{ "<client-id>": ["constellation"] }` and deploy the Worker.
The client secret does not belong in Git. Access protects `/auth/token` and
returns a signed application JWT to an authorized user or service. Turbo protocol
paths bypass Access's HTTP gate because Turbo sends that JWT in a Bearer header;
the Worker verifies its signature, audience, and project on every request.

## Storage and limits

GET streams directly from R2; HEAD reads object metadata. There is no CDN or
Worker response cache. Client responses use `private, no-store`. Infra disables
the bucket's `r2.dev` endpoint and expires objects after 30 days and incomplete
multipart uploads after one day. Developers do not need R2 credentials.

Uploads stream with atomic first-writer-wins behavior. Retries cannot replace an
existing artifact's bytes or metadata. Limits: 64 MiB per artifact, 64 KiB JSON,
128 entries per batch, 256 hexadecimal characters per hash, and 600 requests per
minute per verified identity/project per Cloudflare location. The rate limiter
is abuse control, not a global quota. Metadata and signature tags are preserved;
cache event reports are acknowledged without storing build telemetry.

## Development and verification

Requires Node 24 and uv for the isolated Schemathesis CLI. There is no Python
project or Python lockfile; uv manages Schemathesis's runtime and dependencies.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Checks include TypeScript, formatting, a Wrangler dry run, HTTP-level Vitest
protocol and security tests against local workerd and R2, a real Turbo CLI cache
miss and remote hit, a small Cloudflare Vitest runtime check, and Schemathesis
against the unchanged upstream OpenAPI document. Test fixtures sign ephemeral
JWTs and mock only JWKS retrieval.
[Contract provenance and exceptions](spec/README.md) describe the coverage.
Local tests do not establish live Access or WARP behavior.

## Deployment

Nonprod Workers Builds deploys `main` with `pnpm deploy`; preview builds,
`workers.dev`, and Worker preview URLs are disabled. The Worker deploys its R2
binding, rate limiter, observability settings, and non-secret variables from
`wrangler.jsonc`. Terraform owns the bucket, exact SaaS hostnames, corporate
DNS CNAMEs, Worker routes, Access, Okta claim forwarding, R2 privacy, and
retention. The R2 binding names the existing bucket.

The Cloudflare Workers and Pages GitHub app must include this repository in its
selected repositories. Builds uses the existing nonprod `handbook-workers-builds`
API token; repository merges trigger deployment through Cloudflare.

Only Constellation is enabled. To add a project, set `remote_cache: true` in
`infra/data/projects.json`, apply its hostname and DNS through infra, and wait
for the certificate to become active. Add the applied project/group mapping to
`PROJECTS` here, then apply its Access policy and route. Keep `ACCESS_AUD`
equal to the nonprod `remote_cache_access_aud` output. Verify that anonymous
requests are denied and that a member's signed `custom.groups` claim allows
only their project.

## Client setup

The canonical API is rooted at `/artifacts/...`. The Worker also accepts
`/v8/artifacts/...` for stock Turbo, which appends `/v8` to `TURBO_API`.

A client for Constellation uses `TURBO_API=https://constellation.cache.tractorbeam.tools`,
`TURBO_TEAM=constellation`, and a signed Access application JWT as `TURBO_TOKEN`.
Access's `Cf-Access-Jwt-Assertion` takes precedence over that bearer token.
The local real-Turbo test uses this setup. An invalid assertion cannot fall
back to a valid bearer. Clients should verify artifact signatures before
restoring outputs.

For CI, use Constellation's RWX OIDC and Secrets Manager credential-delivery
path to read `tractorbeam/cloudflare/nonprod/access/constellation-cache-ci`.
Present its `client_id` and `client_secret` to
`GET /auth/token?teamId=constellation` as `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers. The response body is the short-lived Access
application JWT for `TURBO_TOKEN`; the Worker returns it only after validating
Access's signed assertion and the project scope. Set `TURBO_API` and
`TURBO_TEAM` as above. A connected WARP client alone does not give browserless
CI a human project identity; the nonprod Access service credential supplies it.

An authorized developer can call the same token endpoint through a valid WARP
Access session to obtain `TURBO_TOKEN` without sending CI credentials. This
depends on live confirmation that a corporate-enrolled WARP session is accepted
by the nonprod Access application.

Use `TURBO_TEAM` (the project slug) rather than `TURBO_TEAMID`: Turbo accepts a
team ID only when it begins with `team_`, while our project keys do not. Clients
may set `remoteCache.signature: true` and share a secret of at least 32 bytes
through `TURBO_REMOTE_CACHE_SIGNATURE_KEY`; the Worker preserves the resulting
`x-artifact-tag`. Turbo caches task logs along with outputs, so tasks must not
print secrets. Keep `remoteCache.preflight` at its default `false`: in the tested
Turbo 2.11.3 flow, enabling it sends the bearer token on `OPTIONS` but omits it
from the following artifact request, which this Worker correctly denies.

## Sources

- [Turborepo remote-cache specification](https://turborepo.dev/api/remote-cache-spec)
- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Application tokens and custom-claim limits](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Custom OIDC claims](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/#custom-oidc-claims)
