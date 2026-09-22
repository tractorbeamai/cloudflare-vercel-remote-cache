import { readConfig } from "./config.mjs";
import { spawnSync } from "node:child_process";

const config = await readConfig();
if (
  !/^[a-f0-9]{32}$/.test(config.account_id ?? "") ||
  !config.routes?.length ||
  !config.vars.ACCESS_ISSUER ||
  !config.vars.ACCESS_READ_AUD ||
  !config.vars.ACCESS_WRITE_AUD
) {
  throw new Error(
    "Configure the verified nonprod account_id, custom-domain route, Access issuer and audiences before deployment. See README.md.",
  );
}
if (
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id
) {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID does not match the configured deployment account",
  );
}
if (
  config.workers_dev !== false ||
  config.preview_urls !== false ||
  config.exports.default.cache.enabled !== false
) {
  throw new Error("Public previews and gateway caching must remain disabled");
}
const result = spawnSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "deploy", "--minify"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
