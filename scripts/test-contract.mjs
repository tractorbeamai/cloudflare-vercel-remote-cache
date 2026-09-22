import { spawn } from "node:child_process";
import { once } from "node:events";
import { startHarness } from "../tests/harness.mjs";

const harness = await startHarness();
try {
  const child = spawn(
    "uvx",
    [
      "--from",
      "schemathesis==4.27.5",
      "schemathesis",
      "run",
      "spec/upstream.json",
      "--url",
      harness.url,
      "--header",
      `Authorization: Bearer ${harness.token}`,
      "--header",
      "Content-Length: 0",
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  await harness.close();
}
