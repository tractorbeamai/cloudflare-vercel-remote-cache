import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { startHarness } from "./harness.mjs";
const exec = promisify(execFile);

test("real Turbo restores signed artifacts and rejects a changed signing key", async () => {
  const h = await startHarness();
  const dir = await mkdtemp(join(tmpdir(), "turbo-cache-e2e-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "cache-fixture",
        private: true,
        packageManager: "npm@11.6.1",
        scripts: { build: "node build.mjs" },
      }),
    );
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "cache-fixture",
        lockfileVersion: 3,
        packages: { "": { name: "cache-fixture" } },
      }),
    );
    await writeFile(
      join(dir, "turbo.json"),
      JSON.stringify({
        remoteCache: { signature: true },
        tasks: { build: { inputs: ["build.mjs"], outputs: ["out/**"] } },
      }),
    );
    await writeFile(
      join(dir, "build.mjs"),
      `import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
      const count=existsSync('executions')?Number(readFileSync('executions','utf8')):0;
      writeFileSync('executions',String(count+1));mkdirSync('out',{recursive:true});
      writeFileSync('out/artifact.txt','signed build output');console.log('fixture built');`,
    );
    const env = {
      ...process.env,
      TURBO_API: h.url,
      TURBO_TOKEN: h.token,
      TURBO_TEAM: "team_tractorbeam",
      TURBO_TELEMETRY_DISABLED: "1",
      TURBO_REMOTE_CACHE_SIGNATURE_KEY: randomBytes(32).toString("hex"),
    };
    const run = () =>
      exec(
        resolve("node_modules/.bin/turbo"),
        ["run", "build", "--cache=remote:rw"],
        {
          cwd: dir,
          env,
          timeout: 30000,
        },
      );
    await run();
    assert.equal(await readFile(join(dir, "executions"), "utf8"), "1");
    await rm(join(dir, "out"), { recursive: true });
    const restored = await run();
    assert.equal(
      await readFile(join(dir, "executions"), "utf8"),
      "1",
      restored.stdout + restored.stderr,
    );
    assert.equal(
      await readFile(join(dir, "out/artifact.txt"), "utf8"),
      "signed build output",
    );
    env.TURBO_REMOTE_CACHE_SIGNATURE_KEY = randomBytes(32).toString("hex");
    await rm(join(dir, "out"), { recursive: true });
    await run();
    assert.equal(
      await readFile(join(dir, "executions"), "utf8"),
      "2",
      "invalid signature must cause a real rebuild",
    );
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
