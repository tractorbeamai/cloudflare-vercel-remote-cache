# Contract testing scope

`upstream.json` is an unmodified snapshot of Turborepo's MIT-licensed OpenAPI
3.0.3 document, downloaded from its official documentation. `provenance.json`
records the date, URL and SHA-256. Vercel's official artifact API was also reviewed.
The worker is an independent implementation; it does not vendor AdiRishi's or
ducktors' server.

`tests/contract/test_openapi.py` derives a deployment-specific test schema in
memory. The upstream snapshot remains unchanged. Review these adjustments when
refreshing it:

- Prefix paths with `/v8`, matching Vercel and the actual Turbo client.
- Restrict team selectors to this deployment's configured namespace. Cross-team
  rejection is independently tested against the Worker.
- Bound artifact hashes to 256 hex characters; batch/event arrays to 128 entries;
  event hashes to 256 Unicode code points; source SHA/dirty metadata to 128
  characters; and duration to JavaScript's maximum safe integer. R2 metadata is
  also bounded in aggregate. These are deployment resource limits, not claims
  about the unrestricted upstream service.
- Document `413`, `429`, and `503` responses for resource limits and unconfigured
  authentication. Server errors still fail the checks.
- Remove JSON content from HEAD errors: the upstream shared response references
  describe JSON bodies, but HTTP HEAD responses must not carry a body.
- Let the HTTP transport calculate `Content-Length`, rather than fuzzing framing
  independently of the bytes. The Worker requires it for uploads. Request limits,
  response byte counts, empty artifacts and body equality are tested separately.
- Supply an authenticated fixture for structural fuzzing. Remove the security
  declaration from that test view because randomly generated Bearer values are
  not signed Access JWTs, and replacing generated invalid credentials would
  invalidate negative-test expectations. Production security is not removed:
  workerd tests cover missing, forged, expired, wrong-issuer, wrong-audience,
  read-only, human and service credentials, plus an invalid assertion alongside
  a valid bearer. The public upstream snapshot retains its security declarations.
- For coverage cases whose only mutation adds undeclared HTTP headers/query
  properties, omit only the negative-data-rejection assertion. HTTP allows those
  extensions. Response shape/status/server-error checks still run. Other negative
  data rejection checks remain enabled.

The suite runs six operations with 60 Hypothesis examples per operation, plus
Schemathesis coverage-generated cases. A further 30 generated workflows use
Schemathesis cases and response validation for PUT → HEAD → GET → GET → batch
lookup, asserting the bytes, lengths, duration and signature tag across requests.
Dedicated protocol tests cover authorization and concurrent first-writer-wins.
A real Turbo executable verifies signed upload, remote-only restoration after
removing outputs, and rejection with a different signature key.

Error responses include both the self-hosting spec's top-level `code`/`message`
and the real Turbo client's expected nested `error` envelope. Success uploads use
Vercel's `202` response. Artifacts are opaque bytes; the server does not assume an
archive format or attempt to unpack untrusted build outputs.

These checks establish conformance to the pinned deployment contract and tested
client version, not formal certification or all possible client versions. Cloud
Access/WARP policy enforcement, edge cache hits, IAM, and R2 public-access settings
require the deployed checks in the root README. No tests fuzz Vercel's service.
