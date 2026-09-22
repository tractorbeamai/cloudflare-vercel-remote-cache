// Test-only identity provider: fresh signing keys and an ephemeral local R2 bucket.
// The production worker still executes its real JWT verification code.
import { startHarness } from "../tests/harness.mjs";
const harness = await startHarness();
process.stdout.write(
  JSON.stringify({ url: harness.url, token: harness.token }) + "\n",
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await harness.close();
    process.exit(0);
  });
