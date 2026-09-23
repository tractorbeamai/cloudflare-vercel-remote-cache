import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startHarness } from "../scripts/contract-harness.mjs";

let cache;
let project;
const turbo = resolve("node_modules/.bin/turbo");

beforeAll(async () => {
  cache = await startHarness();
  project = await mkdtemp(join(tmpdir(), "remote-cache-turbo-"));
  await mkdir(join(project, "src"));
  await writeFile(join(project, ".gitignore"), "dist/\n.turbo/\nfirst-run\n");
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "remote-cache-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.22.0",
      scripts: { build: "node build.mjs" },
    }),
  );
  await writeFile(
    join(project, "build.mjs"),
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const input = await readFile("src/input.txt", "utf8");
await mkdir("dist", { recursive: true });
await writeFile(join("dist", "result.txt"), input.toUpperCase());
await writeFile(process.env.BUILD_MARKER, "executed");
`,
  );
}, 30_000);

afterAll(async () => {
  await cache?.close();
  if (project) await rm(project, { recursive: true, force: true });
});

function runTurbo(marker, signatureKey) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      turbo,
      [
        "run",
        "build",
        "--cache=local:,remote:rw",
        "--ui=stream",
        "--env-mode=loose",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          TURBO_API: cache.url,
          TURBO_TEAM: "caddi",
          TURBO_TOKEN: cache.token,
          TURBO_TELEMETRY_DISABLED: "1",
          TURBO_NO_UPDATE_NOTIFIER: "1",
          ...(signatureKey
            ? { TURBO_REMOTE_CACHE_SIGNATURE_KEY: signatureKey }
            : {}),
          BUILD_MARKER: marker,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

test.each([
  ["default", {}, undefined],
  ["signed", { signature: true }, "test-only-signature-key-at-least-32-bytes"],
])(
  "real Turbo restores %s artifacts from remote cache",
  async (name, remoteCache, signatureKey) => {
    await writeFile(
      join(project, "turbo.json"),
      JSON.stringify({
        tasks: { build: { outputs: ["dist/**"] } },
        remoteCache,
      }),
    );
    await writeFile(join(project, "src", "input.txt"), `${name} build input\n`);
    await rm(join(project, "dist"), { recursive: true, force: true });
    const firstMarker = join(project, "first-run");
    const first = await runTurbo(firstMarker, signatureKey);
    expect(first.code, first.output).toBe(0);
    expect(await readFile(firstMarker, "utf8")).toBe("executed");
    const hash = first.output.match(/cache miss, executing ([a-f0-9]+)/)?.[1];
    expect(hash, first.output).toBeTruthy();
    const stored = await cache.request(`/v8/artifacts/${hash}`, {
      method: "HEAD",
    });
    expect(stored.status).toBe(200);
    expect(Boolean(stored.headers.get("x-artifact-tag"))).toBe(
      Boolean(signatureKey),
    );
    expect(await readFile(join(project, "dist", "result.txt"), "utf8")).toBe(
      `${name.toUpperCase()} BUILD INPUT\n`,
    );

    await rm(join(project, "dist"), { recursive: true });
    await rm(firstMarker);
    const second = await runTurbo(firstMarker, signatureKey);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toMatch(/cache hit/i);
    expect(await readFile(join(project, "dist", "result.txt"), "utf8")).toBe(
      `${name.toUpperCase()} BUILD INPUT\n`,
    );
    await expect(readFile(firstMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  60_000,
);
