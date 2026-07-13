import { defineConfig } from "@playwright/test";

const localChannel = process.env.T4_E2E_BROWSER_CHANNEL ?? (process.env.CI ? undefined : "chrome");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  outputDir: "test-results/e2e",
  use: {
    browserName: "chromium",
    ...(localChannel === undefined ? {} : { channel: localChannel }),
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
