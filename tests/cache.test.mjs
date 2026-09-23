import { afterAll, beforeAll, expect, test } from "vitest";
import {
  clearArtifacts,
  installJwksFetch,
  startHarness,
} from "./worker-harness.mjs";

let cache;
let restoreFetch;
beforeAll(async () => {
  restoreFetch = installJwksFetch();
  await clearArtifacts();
  cache = await startHarness();
});
afterAll(async () => {
  await cache?.close();
  restoreFetch?.();
});

test("Worker runtime can write and read a private R2 artifact", async () => {
  const upload = await cache.request("/v8/artifacts/abc123", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "private artifact",
  });
  expect(upload.status).toBe(202);
  const response = await cache.request("/artifacts/abc123");
  expect(response.status).toBe(200);
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
    "private artifact",
  );
});

test("Worker runtime rejects unsigned access to stored data", async () => {
  const response = await cache.rawRequest("/artifacts/abc123?teamId=caddi");
  expect(response.status).toBe(401);
});
