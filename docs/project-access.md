# Project authorization

`teamId` is the key in the infra project registry, not an AWS account, Okta group
ID, or GitHub team ID. Infra already derives a GitHub team `proj-<key>` and an
Okta group `Project: <display_name or name>` from each project. Membership stays
in Okta. The cache uses that same project boundary.

Examples from current infra:

| teamId            | Okta group                   | Cache hostname                            |
| ----------------- | ---------------------------- | ----------------------------------------- |
| caddi             | Project: CADDi               | caddi.cache.tractorbeam.tools             |
| carlyle           | Project: Carlyle             | carlyle.cache.tractorbeam.tools           |
| linden-investment | Project: Linden (Investment) | linden-investment.cache.tractorbeam.tools |
| linden-tech       | Project: Linden (Tech)       | linden-tech.cache.tractorbeam.tools       |

The companion infra change generates Access applications for opted-in project keys,
using the native Okta group selector and the existing nonprod Okta provider.
It does not recreate groups, store users, or broaden Cloudflare One enrollment.
Each application's audience grants access to exactly one cache project.

Copy the applied `remote_cache_project_access` output into the Worker's
`PROJECT_ACCESS` binding. Its shape is:

```json
{
  "caddi": "<CADDi app AUD>",
  "carlyle": "<Carlyle app AUD>"
}
```

The Worker verifies the issuer, signature, expiry, audience and identity before
resolving `teamId`/`slug`. A valid token for another configured project receives 403. An unknown audience receives 401. Missing or conflicting selectors receive
400 after authentication. No caller-provided group or team header grants access.
The R2 prefix uses the authorized project key. The same hash
may contain different bytes in different projects without a collision.

Application removal and Worker configuration removal should be coordinated.
Only projects with `remote_cache: true` in the registry receive cache Access
applications and appear in the Worker configuration output. Omitted or false
disables the project cache. Disabling the flag or removing a project removes its
Access application on apply;
remove its AUD from the Worker binding too. Existing signed JWTs can otherwise
remain locally valid until expiration. Artifacts expire through R2 lifecycle.

## Rollout boundaries

- Infra owns R2 and Access policies; the Worker repository owns application code
  and bindings. Keep DNS authoritative in Route 53. The new Access applications
  do not themselves publish DNS or attach Worker domains.
- Nonprod uses its own Okta client and Access organization. Verify native Okta
  group resolution there before attaching routes. Groups are not automatically
  included in Access application JWTs, and this design does not depend on them.
- Corporate WARP enrollment is not proof of a nonprod Access session. Verify the
  supported authentication path with an actual managed device. An Access Bypass
  policy is not a substitute.
- No broad CI exception is created. A service identity must be admitted by the
  specific project application; its signed AUD then follows the same checks.
- No public bucket hostname or S3 credential is required. R2 account admins and
  pre-existing broad API tokens remain outside the Worker's authorization boundary.

## Sources inspected

- [Infra project registry](https://github.com/tractorbeamai/infra/blob/acfe55d96289d88230356af88453da24ee719b97/data/projects.json)
- [Okta project groups](https://github.com/tractorbeamai/infra/blob/acfe55d96289d88230356af88453da24ee719b97/identity/okta/groups.tf)
- [GitHub project team synchronization](https://github.com/tractorbeamai/infra/blob/acfe55d96289d88230356af88453da24ee719b97/github/team_sync.tf)
- [Nonprod account boundary](https://github.com/tractorbeamai/infra/blob/acfe55d96289d88230356af88453da24ee719b97/cloudflare/nonprod/account.tf)
- [Nonprod Okta integration](https://github.com/tractorbeamai/infra/blob/acfe55d96289d88230356af88453da24ee719b97/cloudflare/nonprod/access.tf)
- [Cloudflare application token and group-claim behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
