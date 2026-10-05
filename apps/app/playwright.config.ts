import { defineConfig } from "@playwright/test";

/**
 * The completeness walk: every screen and flow of the app against a running
 * local stack (scripts/e2e-walk.sh starts one, runs this, and stops it).
 * Real broker, real provider node running a real model, real contracts on a
 * local chain. Google Chrome, not the bundled Chromium.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.XORV_APP_URL ?? "http://localhost:3302",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
  },
});
