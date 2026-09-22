import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { configPath, readConfig } from "./config.mjs";

export function accessApplication(template, config, tokens = []) {
  const groups = Object.values(config.vars.PROJECTS);
  const policies = groups.length
    ? [
        {
          name: "Enabled project members",
          decision: "allow",
          precedence: 1,
          include: groups.map((name) => ({
            okta: { identity_provider_id: template.allowed_idps[0], name },
          })),
        },
      ]
    : [];
  const services = Object.keys(config.vars.SERVICE_PROJECTS);
  if (services.length)
    policies.push({
      name: "Project CI identities",
      decision: "non_identity",
      precedence: 2,
      include: services.map((clientId) => {
        const token = tokens.find((t) => t.client_id === clientId);
        if (!token)
          throw new Error(
            `Unknown Access service-token client ID: ${clientId}`,
          );
        if (
          !config.vars.SERVICE_PROJECTS[clientId].length ||
          config.vars.SERVICE_PROJECTS[clientId].some(
            (project) => !Object.hasOwn(config.vars.PROJECTS, project),
          )
        )
          throw new Error(
            `Service identity references a disabled project: ${clientId}`,
          );
        return { service_token: { token_id: token.id } };
      }),
    });
  return { ...template, policies };
}

export function wrangler(args) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`Wrangler ${args.slice(0, 3).join(" ")} failed`);
}

export async function setup(apply = false) {
  const config = await readConfig();
  if (
    config.account_id !== "74bf2f1c3362ea5612cf0795fa1c78aa" ||
    (process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id)
  )
    throw new Error("Setup requires the configured corporate account");
  if (
    config.vars.ACCESS_ISSUER !==
      "https://tractorbeamai.cloudflareaccess.com" ||
    !config.routes?.length ||
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    config.cache.enabled !== false
  )
    throw new Error(
      "Configure protected corporate routes; previews and response caching must remain disabled",
    );
  const template = JSON.parse(
    await readFile(
      new URL("../cloudflare/access.json", import.meta.url),
      "utf8",
    ),
  );
  const root = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
  async function api(path, method = "GET", body) {
    if (!process.env.CLOUDFLARE_API_TOKEN)
      throw new Error("Set CLOUDFLARE_API_TOKEN for Access setup");
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    // Do not log API responses, which can include credentials or identity data.
    if (!response.ok || !result.success)
      throw new Error(
        `Cloudflare ${method} ${path} failed (${response.status})`,
      );
    return result;
  }
  async function list(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await api(
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`,
      );
      items.push(...result.result);
      if (page >= (result.result_info?.total_pages ?? 1)) return items;
    }
  }
  const tokens = Object.keys(config.vars.SERVICE_PROJECTS).length
    ? await list("/access/service_tokens")
    : [];
  const application = accessApplication(template, config, tokens);
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          account: config.account_id,
          application,
          bucket: config.r2_buckets[0].bucket_name,
        },
        null,
        2,
      ),
    );
    return;
  }
  const idp = (
    await api(`/access/identity_providers/${template.allowed_idps[0]}`)
  ).result;
  if (!idp.config?.claims?.includes("groups"))
    throw new Error(
      "Apply the shared Okta/Access groups-claim changes in infra first",
    );
  const apps = await list(
    `/access/apps?name=${encodeURIComponent(template.name)}&exact=true`,
  );
  if (apps.length > 1)
    throw new Error("Multiple cache Access applications found");
  const app = (
    await api(
      apps.length ? `/access/apps/${apps[0].id}` : "/access/apps",
      apps.length ? "PUT" : "POST",
      application,
    )
  ).result;
  if (!/^[a-f0-9]{64}$/.test(app.aud))
    throw new Error("Access did not return a valid application audience");
  const source = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    source.replace(/^ACCESS_AUD = .*$/m, `ACCESS_AUD = "${app.aud}"`),
  );

  const bucket = config.r2_buckets[0].bucket_name;
  const buckets = (
    await api("/r2/buckets?name_contains=" + encodeURIComponent(bucket))
  ).result.buckets;
  if (!buckets.some((b) => b.name === bucket))
    wrangler(["r2", "bucket", "create", bucket]);
  const domains = (await api(`/r2/buckets/${bucket}/domains/custom`)).result
    .domains;
  if (domains.length)
    throw new Error(
      "Remove public custom domains from the private cache bucket before deployment",
    );
  wrangler(["r2", "bucket", "dev-url", "disable", bucket]);
  wrangler([
    "r2",
    "bucket",
    "lifecycle",
    "set",
    bucket,
    "--file",
    "cloudflare/r2-lifecycle.json",
    "--force",
  ]);
  console.log(
    "Access and private R2 configured; audience saved to wrangler.toml",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.slice(2).some((arg) => arg !== "--apply"))
    throw new Error("Usage: npm run setup -- [--apply]");
  await setup(process.argv.includes("--apply"));
}
