import { defineConfig } from "@playwright/test";
import browser from "./playwright.browser.config";

// Explicit live-provider qualification; ordinary browser smoke stays credential-free.
export default defineConfig({
  ...browser,
  testMatch: ["claude-warm-runtime.spec.ts"],
  timeout: 600_000,
  use: { ...browser.use, trace: "off", screenshot: "off" },
});
