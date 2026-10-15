import config from "@tractorbeam/oxfmt-config";
import { defineConfig } from "oxfmt";

export default defineConfig({
  ...config,
  ignorePatterns: [
    ...config.ignorePatterns,
    "pnpm-lock.yaml",
    "worker-configuration.d.ts",
    "spec/upstream.json",
    ".venv/**",
    ".wrangler/**",
    "reports/**",
    ".schemathesis/**",
    ".claude/**",
  ],
});
