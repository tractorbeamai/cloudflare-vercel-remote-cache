import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/cache.test.mjs"] },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        r2Buckets: ["ARTIFACTS"],
        ratelimits: {
          REQUEST_LIMITER: {
            namespace_id: "1001",
            simple: { limit: 100000, period: 60 },
          },
          REQUEST_LIMITER_LOW: {
            namespace_id: "1002",
            simple: { limit: 2, period: 60 },
          },
        },
      },
    }),
  ],
});
