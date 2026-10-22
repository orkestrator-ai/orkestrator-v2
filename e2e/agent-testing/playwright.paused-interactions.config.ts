import { defineConfig } from "@playwright/test";
import browser from "./playwright.browser.config";

// Explicit live-provider qualification; each case waits past ten minutes.
export default defineConfig({
  ...browser,
  testMatch: ["paused-interactions-live.spec.ts"],
  timeout: 45 * 60_000,
  use: { ...browser.use, trace: "off", screenshot: "off" },
});
