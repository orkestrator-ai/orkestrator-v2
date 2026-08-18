import { defineConfig } from "@playwright/test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const baseURL = "http://127.0.0.1:1422";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  // `*.spec.ts` expands to `**/*.spec.ts`, which would otherwise sweep in the
  // agent-testing specs. Those drive a real profile's Electron/backend stack
  // through their own configs and have nothing to do with this fixture server.
  testIgnore: "agent-testing/**",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "line",
  outputDir: path.join(repositoryRoot, "output/playwright/test-results"),
  webServer: {
    command:
      "bunx vite ../../e2e/fixture --config vite.config.ts --host 127.0.0.1 --port 1422 --strictPort",
    cwd: path.join(repositoryRoot, "apps/web"),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL,
    browserName: "chromium",
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
