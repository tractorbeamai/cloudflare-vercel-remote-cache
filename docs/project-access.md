# Project authorization

The corporate account (`74bf2f1c3362ea5612cf0795fa1c78aa`) owns the cache Worker,
private R2 bucket and single Access application. Its issuer is
`https://tractorbeamai.cloudflareaccess.com`, the existing workforce/WARP organization.
There is no corporate-to-nonprod identity handoff.

## Shared identity configuration

Infra owns two shared integration changes:

- `identity/okta/apps.tf`: the corporate Cloudflare One OAuth app emits `groups`,
  filtered with `STARTS_WITH "Project: "`. Its existing SSWS-authenticated Okta
  provider supports the app-level `groups_claim` block. Provider 7 marks that
  block deprecated; its suggested replacement requires a custom authorization
  server. This change keeps the existing org authorization server.
- `cloudflare/access.tf`: the existing native Okta IdP forwards `groups` as a
  custom claim. Its credentials, assignment rules, and device-trust policies remain
  managed by infra.

The application token must contain an array at `custom.groups`, for example:

```json
{ "custom": { "groups": ["Project: CADDi", "Project: Linden (Tech)"] } }
```

This is a signed authorization input, not a header supplied by the client. The
Worker verifies the token before reading claims. An absent group array, unrelated
group, or oversized custom object denies access. WARP authentication must be tested
with a fresh managed-device session after the shared integration is applied.

## Project registry

`remote_cache: true` in infra's `data/projects.json` enables a namespace. The
Worker repo syncs project keys to exact Okta group names into `wrangler.toml`:

```toml
[vars.PROJECTS]
caddi = "Project: CADDi"
linden-tech = "Project: Linden (Tech)"
```

The registry does not copy users or memberships. Missing/false opts out. Deployment
reads the main-branch registry, so unmerged edits cannot enable access. A flag or
group-name change requires redeploying the Worker; changing the registry alone does
not update a running deployment. JWT membership changes require session refresh.

Infra and the sync command check the combined size of all registered project
groups, including disabled projects, because a user may belong to all of them.
The 700-byte/64-group bound leaves headroom below Access's approximate 1 KB custom
claim limit. The Worker also rejects custom claims larger than 700 UTF-8 bytes.
If the project set outgrows this limit, change the authorization design rather than
silently falling back to mere application admission.

## Service identities

Service-token JWTs have an empty `sub` and a signed `common_name` containing the
client ID. They do not inherit human groups. The Worker requires an exact entry in
`SERVICE_PROJECTS`, checks the requested project is still enabled, and grants both
reads and writes only to those projects. An empty map allows no service identities.
Setup resolves the configured client IDs to existing Access token IDs and includes
only those in a Service Auth policy. It does not create or handle token secrets.

## Ownership and rollout

All cache resources and settings live in this repository. Wrangler manages Worker
code, routes and bindings; setup uses the Access API and Wrangler's R2 commands
for features outside the TOML schema. The infra PR creates no cache bucket or
per-project Access applications. The global WARP authentication setting is not
changed; the cache application enables it explicitly.

The intended wildcard hostname still needs corporate zone/proxy/TLS routing and
Route 53 DNS. Verify live WARP claim delivery and cross-project denial before
publishing traffic. A local JWT fixture establishes the Worker behavior, not the
external IdP or WARP integration.

Sources: [project registry](https://github.com/tractorbeamai/infra/blob/main/data/projects.json),
[Okta project groups](https://github.com/tractorbeamai/infra/blob/main/identity/okta/groups.tf),
[shared identity changes](https://github.com/tractorbeamai/infra/pull/1541), and
[Cloudflare application-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
