import { test } from "node:test";
import assert from "node:assert/strict";
import { selectProjects } from "../scripts/sync-projects.mjs";
import { accessApplication } from "../scripts/setup.mjs";

const registry = {
  $schema: "./projects.schema.json",
  enabled: { name: "Enabled", remote_cache: true },
  renamed: {
    name: "Machine",
    display_name: "Human (Name)",
    remote_cache: true,
  },
  disabled: { name: "Disabled", remote_cache: false },
  missing: { name: "Missing" },
};

test("project registry requires explicit opt-in and preserves exact Okta names", () => {
  assert.deepEqual(selectProjects(registry), {
    enabled: "Project: Enabled",
    renamed: "Project: Human (Name)",
  });
  assert.throws(() =>
    selectProjects({ bad: { name: "Bad", remote_cache: "true" } }),
  );
  assert.throws(() =>
    selectProjects({ "../bad": { name: "Bad", remote_cache: true } }),
  );
  assert.throws(() =>
    selectProjects({ a: { name: "Same" }, b: { name: "Same" } }),
  );
});

test("claim-size budget includes disabled project memberships and UTF-8 bytes", () => {
  const oversized = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `p${i}`,
      { name: `${i}${"é".repeat(50)}`, remote_cache: false },
    ]),
  );
  assert.throws(() => selectProjects(oversized), /budget/);
});

test("single Access app admits enabled project groups and only mapped service tokens", () => {
  const template = { allowed_idps: ["okta-id"] };
  const config = {
    vars: {
      PROJECTS: selectProjects(registry),
      SERVICE_PROJECTS: { "ci.access": ["enabled"] },
    },
  };
  const result = accessApplication(template, config, [
    { client_id: "ci.access", id: "service-id" },
  ]);
  assert.deepEqual(result.policies[0].include, [
    { okta: { identity_provider_id: "okta-id", name: "Project: Enabled" } },
    {
      okta: { identity_provider_id: "okta-id", name: "Project: Human (Name)" },
    },
  ]);
  assert.equal(result.policies[1].decision, "non_identity");
  assert.deepEqual(result.policies[1].include, [
    { service_token: { token_id: "service-id" } },
  ]);
  assert.throws(() => accessApplication(template, config), /Unknown/);
  config.vars.SERVICE_PROJECTS["ci.access"] = ["disabled"];
  assert.throws(
    () =>
      accessApplication(template, config, [
        { client_id: "ci.access", id: "service-id" },
      ]),
    /disabled/,
  );
  assert.deepEqual(
    accessApplication(template, {
      vars: { PROJECTS: {}, SERVICE_PROJECTS: {} },
    }).policies,
    [],
  );
});
