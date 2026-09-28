# Project authorization

The nonprod account (`b534f6f9c114635cacb3cfd15861c516`) owns the Worker,
private bucket and one Access application. Its issuer is
`https://tractorbeam-nonprod.cloudflareaccess.com`, the existing developer WARP
organization.

Infra is the source of truth for project opt-in and shared identity. Each
`remote_cache: true` project in `data/projects.json` contributes one existing
Okta `Project: <display_name or name>` group to the application's Allow policy.
The nonprod Okta app emits only `Project: ` memberships in its `groups` claim;
the Access IdP forwards that claim. The Worker verifies the signed token and
requires the requested project's group in `custom.groups`. Missing or malformed
claims deny access. The group claim is bounded to 700 bytes and 64 groups across
all registered projects, including those without cache access.

The applied nonprod Terraform stack exports:

- `remote_cache_access_aud`: paste into `vars.ACCESS_AUD` in `wrangler.jsonc`.
- `remote_cache_project_groups`: paste into `vars.PROJECTS` in `wrangler.jsonc`.

Changes to flags or group names require a coordinated Worker deployment. In
particular, disabling a project without updating the Worker map can leave it
accessible to a user who is admitted to the same Access app through another
enabled project. Live JWT membership changes also require a refreshed Access
session. Verify the claim on a managed device after applying the shared Okta
change and before routing traffic.

Infra owns the Access app, R2 bucket, disabled public bucket endpoint, and
lifecycle. Wrangler owns Worker code, bindings and runtime settings. Corporate Cloudflare
owns authoritative DNS. Nonprod Terraform owns Cloudflare for SaaS hostnames and
exact Worker routes, enabled only after the certificates and Access are ready. Service tokens are denied by default;
a project-specific Service Auth policy and Worker map must be added together if
CI access is needed.

Sources: [project registry](https://github.com/tractorbeamai/infra/blob/main/data/projects.json),
[Okta project groups](https://github.com/tractorbeamai/infra/blob/main/identity/okta/groups.tf),
[shared infra change](https://github.com/tractorbeamai/infra/pull/1541), and
[Cloudflare application-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
