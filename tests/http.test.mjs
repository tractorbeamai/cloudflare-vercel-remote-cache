import { test, expect, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startHarness } from "../scripts/contract-harness.mjs";
let h;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});
const path = (id) => `/artifacts/${id}`;
const binaryText = async (response) =>
  new TextDecoder().decode(await response.arrayBuffer());
const upload = (id, body, headers = {}) =>
  h.request(path(id), {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream", ...headers },
  });

test("artifact bytes and metadata survive upload, HEAD, repeated GET and batch query", async () => {
  const id = randomBytes(8).toString("hex");
  const body = randomBytes(4096);
  const metadata = {
    "x-artifact-duration": "123",
    "x-artifact-tag": "signed-tag",
    "x-artifact-sha": "abc",
    "x-artifact-dirty-hash": "def",
  };
  const stored = await upload(id, body, metadata);
  assert.equal(stored.status, 202);
  const { urls } = await stored.json();
  assert.equal(new URL(urls[0]).pathname, path(id));
  for (const method of ["HEAD", "GET", "GET"]) {
    const response = await h.request(path(id), { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), "4096");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    for (const [key, value] of Object.entries(metadata))
      assert.equal(response.headers.get(key), value);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      method === "HEAD" ? Buffer.alloc(0) : body,
    );
  }
  const result = await h.request("/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: [id, "000000"] }),
  });
  assert.deepEqual(await result.json(), {
    [id]: { size: 4096, taskDurationMs: 123, tag: "signed-tag" },
    "000000": null,
  });
});

test("missing, invalid, expired, wrong issuer and wrong audience tokens cannot read stored artifacts", async () => {
  await upload("a11", "private bytes");
  assert.equal((await h.request(path("a11"))).status, 200);
  for (const token of [
    "",
    "invalid",
    await h.sign({ exp: 1 }),
    await h.sign({ aud: "another-app" }),
    await h.sign({ iss: "https://wrong.cloudflareaccess.com" }),
  ]) {
    const r = await h.rawRequest(`${path("a11")}?teamId=caddi`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, "unauthorized");
  }
  assert.equal(
    (
      await h.request(path("a11"), {
        headers: { "Cf-Access-Jwt-Assertion": "forged" },
      })
    ).status,
    401,
  );
});

test("team selectors require project permission", async () => {
  await upload("a12", "authorized");
  for (const suffix of ["?teamId=other", "?slug=other"]) {
    assert.equal((await h.request(path("a12") + suffix)).status, 403);
    assert.equal((await upload("a12" + suffix, "blocked")).status, 403);
  }
  assert.equal(
    (await h.request(path("a12") + "?teamId=caddi&teamId=other")).status,
    400,
  );
  assert.equal((await h.request(path("a12") + "?slug=caddi")).status, 200);
});

test("concurrent writes and retries preserve the first committed artifact", async () => {
  const writes = await Promise.all(
    ["first", "second"].map((body) => upload("a14", body)),
  );
  assert.deepEqual(
    writes.map((r) => r.status),
    [202, 202],
  );
  const first = await binaryText(await h.request(path("a14")));
  assert.ok(["first", "second"].includes(first));
  await upload("a14", "replacement");
  assert.equal(await binaryText(await h.request(path("a14"))), first);
});

test("unknown artifacts return 404 and are immediately readable after upload", async () => {
  assert.equal((await h.request(path("a15"))).status, 404);
  assert.equal((await h.request(path("a15"), { method: "HEAD" })).status, 404);
  await upload("a15", "new");
  assert.equal(await binaryText(await h.request(path("a15"))), "new");
});

test("malformed requests are rejected and empty binary artifacts round-trip", async () => {
  assert.equal((await upload("not-hex", "x")).status, 400);
  assert.equal(
    (await upload("a16", "x", { "x-artifact-duration": "-1" })).status,
    400,
  );
  assert.equal(
    (await upload("a16", "x", { "x-artifact-tag": "x".repeat(601) })).status,
    400,
  );
  assert.equal(
    (await upload("a16", "x", { "Content-Type": "application/json" })).status,
    400,
  );
  assert.equal((await upload("a16", "")).status, 202);
  assert.equal(
    (await h.request(path("a16"))).headers.get("Content-Length"),
    "0",
  );
  assert.equal(
    (await h.request("/internal/delete-expired-objects", { method: "POST" }))
      .status,
    404,
  );
  assert.equal(
    (
      await h.request("/artifacts", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
    400,
  );
});

test("R2 metadata boundaries return client errors instead of storage failures", async () => {
  const response = await upload("a17", "x", {
    "x-artifact-sha": "x".repeat(1024),
    "x-artifact-dirty-hash": "x".repeat(1024),
  });
  assert.equal(response.status, 400);
  assert.equal((await h.request(path("a17"))).status, 404);
});

test("unsupported methods return 405 and an Allow header", async () => {
  const response = await h.request("/artifacts/status", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
});

test("Access assertion works without a bearer and absent Access config fails closed", async () => {
  const response = await h.rawRequest("/artifacts/status?teamId=caddi", {
    headers: { "Cf-Access-Jwt-Assertion": h.token },
  });
  assert.equal(response.status, 200);
  const unconfigured = await startHarness({ PROJECTS: {} });
  try {
    assert.equal((await unconfigured.request("/artifacts/status")).status, 503);
  } finally {
    await unconfigured.close();
  }
});

test("configured artifact and JSON limits reject requests without creating artifacts", async () => {
  const limited = await startHarness({ MAX_ARTIFACT_BYTES: 4 });
  try {
    const response = await limited.request("/artifacts/a18", {
      method: "PUT",
      body: "12345",
      headers: { "Content-Type": "application/octet-stream" },
    });
    assert.equal(response.status, 413);
    assert.equal((await limited.request("/artifacts/a18")).status, 404);
    const json = await limited.request("/artifacts/events", {
      method: "POST",
      body: " ".repeat(65537),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(json.status, 413);
  } finally {
    await limited.close();
  }
});

test("service-token identities are accepted only with a signed application JWT", async () => {
  const token = await h.sign({ sub: "", common_name: "test-client.access" });
  assert.equal(
    (
      await h.request("/artifacts/status", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
  const invalid = await h.sign({ sub: "" });
  assert.equal(
    (
      await h.request("/artifacts/status", {
        headers: { Authorization: `Bearer ${invalid}` },
      })
    ).status,
    401,
  );
  const other = await startHarness();
  try {
    assert.equal(
      (
        await h.request("/artifacts/status", {
          headers: { Authorization: `Bearer ${other.token}` },
        })
      ).status,
      401,
    );
  } finally {
    await other.close();
  }
});

test("rate limit is enforced per verified identity", async () => {
  const limited = await startHarness({}, { rateLimit: 2 });
  try {
    assert.equal((await limited.request("/artifacts/status")).status, 200);
    assert.equal((await limited.request("/artifacts/status")).status, 200);
    assert.equal((await limited.request("/artifacts/status")).status, 429);
    const token = await limited.sign({ sub: "other-user" });
    assert.equal(
      (
        await limited.request("/artifacts/status", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
  } finally {
    await limited.close();
  }
});

test("Turbo v8 route and root route address the same artifact", async () => {
  assert.equal((await h.request("/artifacts/status")).status, 200);
  assert.equal((await h.request("/v8/artifacts/status")).status, 200);
  const id = randomBytes(8).toString("hex");
  assert.equal((await upload(id, "from root")).status, 202);
  assert.equal(
    await binaryText(await h.request(`/v8/artifacts/${id}`)),
    "from root",
  );
});

test("binary artifacts retain exact bytes across boundary sizes", async () => {
  for (const length of [0, 1, 2, 255, 256, 4095, 4096, 65536]) {
    const id = randomBytes(16).toString("hex");
    const body = randomBytes(length);
    assert.equal((await upload(id, body)).status, 202);
    for (const method of ["HEAD", "GET", "GET"]) {
      const response = await h.request(path(id), { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Length"), String(length));
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        method === "HEAD" ? Buffer.alloc(0) : body,
      );
    }
  }
});

test("identical hashes in different projects have separate bytes and metadata", async () => {
  const id = "b001";
  const carlyleToken = await h.sign({
    custom: { groups: ["Project: Carlyle"] },
  });
  const carlyle = (route, init = {}) =>
    h.request(`${route}?teamId=carlyle`, {
      ...init,
      headers: { Authorization: `Bearer ${carlyleToken}`, ...init.headers },
    });
  await upload(id, "CADDi artifact", { "x-artifact-tag": "caddi-tag" });
  assert.equal(await binaryText(await h.request(path(id))), "CADDi artifact");
  assert.equal((await carlyle(path(id))).status, 404);
  assert.equal(
    (
      await carlyle(path(id), {
        method: "PUT",
        body: "Carlyle artifact",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-artifact-tag": "carlyle-tag",
        },
      })
    ).status,
    202,
  );
  for (let i = 0; i < 2; i++) {
    for (const [read, body, tag] of [
      [(route, init) => h.request(route, init), "CADDi artifact", "caddi-tag"],
      [carlyle, "Carlyle artifact", "carlyle-tag"],
    ]) {
      const response = await read(path(id));
      assert.equal(response.status, 200);
      assert.equal(await binaryText(response), body);
      assert.equal(response.headers.get("x-artifact-tag"), tag);
      const head = await read(path(id), { method: "HEAD" });
      assert.equal(
        head.headers.get("Content-Length"),
        String(Buffer.byteLength(body)),
      );
      assert.equal(head.headers.get("x-artifact-tag"), tag);
      const batch = await read("/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: [id] }),
      });
      assert.deepEqual(await batch.json(), {
        [id]: { size: Buffer.byteLength(body), tag, taskDurationMs: 0 },
      });
    }
  }
});

test("project claims deny cross-project operations after successful reads", async () => {
  await upload("b002", "CADDi artifact");
  const writer = await h.sign({ custom: { groups: ["Project: Carlyle"] } });
  const auth = { Authorization: `Bearer ${writer}` };
  await h.request("/artifacts/b002?teamId=carlyle", {
    method: "PUT",
    body: "Carlyle artifact",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
  });
  assert.equal(
    (await h.request("/artifacts/b002?teamId=carlyle", { headers: auth }))
      .status,
    200,
  );
  for (const [route, method, body] of [
    ["/artifacts/b002", "GET"],
    ["/artifacts/b002", "HEAD"],
    ["/artifacts/b002", "PUT", "overwrite"],
    ["/artifacts", "POST", '{"hashes":["b002"]}'],
    ["/artifacts/events", "POST", "[]"],
    ["/artifacts/status", "GET"],
  ]) {
    const response = await h.request(`${route}?teamId=carlyle`, {
      method,
      body,
    });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
  const token = await h.sign({ sub: "", common_name: "caddi-ci.access" });
  assert.equal(
    (
      await h.request("/artifacts/b002?teamId=carlyle", {
        headers: { Authorization: `Bearer ${token}`, "X-Team-Id": "carlyle" },
      })
    ).status,
    403,
  );
});

test("team selection is explicit, unambiguous, and cannot inject a storage path", async () => {
  for (const suffix of [
    "",
    "?teamId=",
    "?teamId=caddi&slug=carlyle",
    "?slug=caddi&slug=caddi",
    "?teamId=caddi%2F..%2Fcarlyle",
    "?teamId=__proto__",
  ]) {
    const response = await h.rawRequest(`/artifacts/status${suffix}`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    assert.equal(response.status, 400, suffix);
  }
  assert.equal(
    (await h.request("/artifacts/status?teamId=constructor")).status,
    403,
  );
  assert.equal(
    (await h.request("/artifacts/status?teamId=caddi&slug=caddi")).status,
    200,
  );
});

test.each([
  ["empty project group", { PROJECTS: { caddi: "" } }],
  ["invalid project key", { PROJECTS: { "../caddi": "Project: CADDi" } }],
  ["missing audience", { ACCESS_AUD: "" }],
  [
    "invalid service project",
    { SERVICE_PROJECTS: { "test-client.access": ["../caddi"] } },
  ],
])("%s configuration fails closed", async (_case, overrides) => {
  const broken = await startHarness(overrides);
  try {
    expect((await broken.request("/artifacts/status")).status).toBe(503);
  } finally {
    await broken.close();
  }
});

test("membership in multiple projects grants independent read and write access", async () => {
  const token = await h.sign({
    custom: { groups: ["Project: CADDi", "Project: Carlyle"] },
  });
  for (const project of ["caddi", "carlyle"]) {
    const route = `/artifacts/c01?teamId=${project}`;
    assert.equal(
      (
        await h.request(route, {
          method: "PUT",
          body: project,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
          },
        })
      ).status,
      202,
    );
    assert.equal(
      await binaryText(
        await h.request(route, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
      project,
    );
  }
});

test.each([
  ["missing", undefined],
  ["null", null],
  ["empty", {}],
  ["no memberships", { groups: [] }],
  ["string memberships", { groups: "Project: CADDi" }],
  ["other project", { groups: ["Project: Carlyle"] }],
  ["wrong case", { groups: ["Project: caddi"] }],
  ["oversized", { groups: ["Project: CADDi"], padding: "x".repeat(700) }],
])("%s group claim does not authorize", async (_case, custom) => {
  const token = await h.sign({ custom });
  const response = await h.request("/artifacts/status", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Groups": "Project: CADDi",
    },
  });
  expect(response.status).toBe(403);
});

test("organization tokens do not authorize", async () => {
  const token = await h.sign({ type: "org" });
  assert.equal(
    (
      await h.request("/artifacts/status", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
});

test("service tokens need an explicit mapping even if they contain group claims", async () => {
  const token = await h.sign({ sub: "", common_name: "unmapped.access" });
  assert.equal(
    (
      await h.request("/artifacts/status", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );
  const disabled = await startHarness({
    PROJECTS: { carlyle: "Project: Carlyle" },
  });
  try {
    const token = await disabled.sign({
      sub: "",
      common_name: "test-client.access",
    });
    assert.equal(
      (
        await disabled.request("/artifacts/status", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      403,
    );
  } finally {
    await disabled.close();
  }
});
