import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
// Override to run beside another checkout's fixture server on the default port.
const port = Number.parseInt(process.env.ORKESTRATOR_E2E_PORT ?? "1422", 10);
const baseURL = `http://127.0.0.1:${port}`;
// Opt-in engine override for qualification runs, e.g. `webkit` for Safari's
// engine, which has no `moveBefore`. The project names keep naming the layout
// profile (phone or desktop viewport), whichever engine runs them. Specs that
// require Chrome or CDP must gate on browserName rather than the project name.
const browserName = process.env.ORKESTRATOR_E2E_BROWSER ?? "chromium";
if (browserName !== "chromium" && browserName !== "webkit" && browserName !== "firefox") {
  throw new Error(`Unsupported ORKESTRATOR_E2E_BROWSER: ${browserName}`);
}

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  // `*.spec.ts` expands to `**/*.spec.ts`, which would otherwise sweep in the
  // agent-testing, preview, and public-site specs. Those use their own servers
  // and configs rather than this component fixture server.
  testIgnore: ["agent-testing/**", "preview/**", "public-site/**"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "line",
  globalSetup: "./fixture-server-owner.ts",
  outputDir: path.join(repositoryRoot, "output/playwright/test-results"),
  webServer: {
    command: `bunx vite ../../e2e/fixture --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: path.join(repositoryRoot, "apps/web"),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL,
    browserName,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1024, height: 900 } },
    },
  ],
});
