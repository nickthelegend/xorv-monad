import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test spawns a real server process through tsx.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
