# Contract testing scope

`upstream.json` is an unmodified snapshot of Turborepo's MIT-licensed OpenAPI
3.0.3 document. `provenance.json` records the source, date and SHA-256. The CLI
reads this file directly: no schema rewriting, generated overlay, or Python hooks.

`npm run test:contract` starts an isolated workerd/R2 fixture and invokes the
pinned Schemathesis CLI through `uvx`. Authentication uses freshly generated
Access-style JWTs and the production verifier. No cloud credentials are needed.
The routes match the schema at `/artifacts/...`; there is no `/v8` alias.
**Stock Turbo appends `/v8` and is intentionally incompatible with these routes.**

`schemathesis.toml` keeps the test inputs and exceptions visible:

- Team selectors and authorization use the local CADDi fixture. Credential generation
  and undeclared extra parameters are disabled; dedicated Node tests exercise
  invalid credentials, team isolation and malformed requests.
- Upload framing uses a configured Content-Length, recalculated by the HTTP
  client for nonempty bodies. PUT generates positive cases only because
  negative framing probes can fail in Miniflare before reaching the Worker.
  Other operations retain positive and negative generation; Node tests cover
  malformed uploads and cross-project authorization.
- HEAD skips JSON response-body validation because the upstream shared error
  schema requires a body that HTTP HEAD forbids. Other HEAD checks remain enabled.
- PUT/POST positive acceptance allows 400 for deployment resource limits absent
  from the upstream schema. This means the CLI alone cannot prove valid writes
  succeed. Node tests assert successful uploads, byte-for-byte reads, metadata,
  batch lookups, per-project first-writer-wins, and the resource limits independently.

All six operations run coverage and fuzzing, with up to 60 fuzzing examples per
operation. No response statuses are added to the upstream schema. Server errors,
undocumented statuses and response-shape failures still fail the run, except for
the explicit HEAD body exception. There are no schema links for stateful tests;
Node tests cover the upload → HEAD → repeated GET → batch workflow.

These checks establish the tested protocol behavior, not formal certification
or stock Turbo compatibility. Cloud Access/WARP enforcement, edge cache hits,
IAM and bucket public-access settings require the deployed checks in the root
README. No tests target Vercel's service.

CLI documentation: <https://schemathesis.readthedocs.io/en/stable/quick-start/>.
