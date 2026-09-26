import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The stdio tests spawn a real server process through tsx, which takes a
    // few seconds on Windows; the unit tests are fast.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
