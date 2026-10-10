import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{shared,server,web}/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
