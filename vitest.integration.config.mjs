import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/http.test.mjs", "tests/turbo.test.mjs"],
    environment: "node",
  },
});
