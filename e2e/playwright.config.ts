import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { enterPrivateTestTmpdir } from "../tests/private-tmpdir";

// Workers inherit a private TMPDIR, so the browser profiles of a worker that is
// killed land where a later run can remove them (0248). Workers load this file
// too and reuse the runner's directory.
process.once("exit", enterPrivateTestTmpdir());

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

// Review validation passes the slots the host scheduler granted this suite.
// Playwright would otherwise start half the cores whatever was reserved, beside
// the rest of the validation plan. Never exceed that default either, so an idle
// host runs the suite exactly as before; a person's run keeps the default.
const playwrightDefaultWorkers = Math.max(1, Math.floor(os.cpus().length / 2));
const grantedWorkers = Number.parseInt(process.env.ORKESTRATOR_TEST_WORKERS ?? "", 10);
const workers = grantedWorkers > 0 ? Math.min(grantedWorkers, playwrightDefaultWorkers) : undefined;

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  // `*.spec.ts` expands to `**/*.spec.ts`, which would otherwise sweep in the
  // agent-testing, preview, and public-site specs. Those use their own servers
  // and configs rather than this component fixture server.
  testIgnore: ["agent-testing/**", "preview/**", "public-site/**"],
  fullyParallel: true,
  workers,
  // Review validation retries a failed test once, so one timing miss on a busy
  // host does not fail the whole check. A test that passes on its retry is
  // still listed as flaky in the check's output; record it in
  // docs/tests/flaky-tests/ as for any flake.
  retries: process.env.ORKESTRATOR_REVIEW_VALIDATION === "1" ? 1 : 0,
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
