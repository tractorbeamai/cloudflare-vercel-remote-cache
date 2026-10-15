import oxlintConfig from "@tractorbeam/oxlint-config";
import { defineConfig } from "oxlint";

const lint = oxlintConfig({ react: false });

export default defineConfig({
  ...lint,
  overrides: [
    ...lint.overrides,
    {
      // Tests and harness scripts are deliberately sequential: each step
      // depends on the previous request's outcome and shared Worker state.
      files: ["tests/**", "scripts/**"],
      rules: { "no-await-in-loop": "off" },
    },
  ],
  ignorePatterns: [
    "worker-configuration.d.ts",
    "dist/**",
    ".wrangler/**",
    ".venv/**",
    ".claude/**",
  ],
});
