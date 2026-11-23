import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { reviewValidationRunOptions } from "../tests/playwright-review-validation";
import { installPlaywrightRunnerSigterm } from "../tests/playwright-runner-sigterm";
import { enterPrivateTestTmpdir } from "../tests/private-tmpdir";
import { FIXTURE_OUT_DIR_ENV, FIXTURE_PREVIEW_IDENTITY_ENV } from "./fixture-server-identity";
import { fixtureServerMode } from "./fixture-server-mode";

// Workers inherit a private TMPDIR, so the browser profiles of a worker that is
// killed land where a later run can remove them (#1425). Workers load this file
// too and reuse the runner's directory.
process.once("exit", enterPrivateTestTmpdir());
// A SIGTERM to the runner stops its `webServer` too, which Playwright starts
// in a process group of its own (to-do 8040, retired). A no-op in workers.
installPlaywrightRunnerSigterm();

const repositoryRoot = path.resolve(import.meta.dirname, "..");
// Override to run beside another run or checkout that holds the default port.
const port = Number.parseInt(process.env.ORKESTRATOR_E2E_PORT ?? "1422", 10);
const baseURL = `http://127.0.0.1:${port}`;
const fixturePreviewIdentity = `build-${randomUUID()}`;
// Opt-in engine override for qualification runs, e.g. `webkit` for Safari's
// engine, which has no `moveBefore`. The project names keep naming the layout
// profile (phone or desktop viewport), whichever engine runs them. Specs that
// require Chrome or CDP must gate on browserName rather than the project name.
const browserName = process.env.ORKESTRATOR_E2E_BROWSER ?? "chromium";
if (browserName !== "chromium" && browserName !== "webkit" && browserName !== "firefox") {
  throw new Error(`Unsupported ORKESTRATOR_E2E_BROWSER: ${browserName}`);
}

// A person's run starts a third of the cores. At Playwright's own default,
// half, each worker's Chromium processes plus the shared Vite server held a
// 12-core host near load 30. On beelink (16 cores) a third finished within the
// spread of half's run times, with the same failures and about 11 % less CPU
// (to-do 8201, retired; docs/development/testing-guide.md, "Component suite
// workers"). `--workers` on the command line still wins.
const cores = os.cpus().length;
const defaultWorkers = Math.max(1, Math.floor(cores / 3));
// Review validation passes the slots the host scheduler granted this suite, so
// a busy host runs fewer browser workers beside the rest of the validation
// plan. It is capped at Playwright's half the cores, never at the person's
// default: the scheduler has already counted what else the host is doing.
const playwrightDefaultWorkers = Math.max(1, Math.floor(cores / 2));
const grantedWorkers = Number.parseInt(
  process.env.ORKESTRATOR_VALIDATION_GRANTED_WORKERS ?? "",
  10,
);
const workers =
  grantedWorkers > 0 ? Math.min(grantedWorkers, playwrightDefaultWorkers) : defaultWorkers;

/**
 * The fixture page's server (e2e/fixture-server-mode.ts). By default the run
 * builds the fixture and serves the build: through the dev server every page
 * load fetched about 1,900 modules and took about 2 s, half the suite's time
 * (docs/development/testing-guide.md, "The fixture server").
 */
function fixtureWebServer() {
  const fixture = "../../e2e/fixture";
  const config = "vite.fixture.config.ts";
  const common = {
    cwd: path.join(repositoryRoot, "apps/web"),
    url: baseURL,
    // The build takes seconds alone, longer beside a busy validation plan.
    timeout: 120_000,
  };
  if (fixtureServerMode() === "dev") {
    return {
      ...common,
      command: `bunx vite ${fixture} --config ${config} --host 127.0.0.1 --port ${port} --strictPort`,
      reuseExistingServer: !process.env.CI,
    };
  }
  // In the runner's private TMPDIR: two runs in one checkout never serve each
  // other's build, and the build goes when the directory does.
  return {
    ...common,
    command:
      `bunx vite build ${fixture} --config ${config} --emptyOutDir` +
      ` && bunx vite preview ${fixture} --config ${config}` +
      ` --host 127.0.0.1 --port ${port} --strictPort`,
    // React's development build, which the fixtures' retry paths need, even
    // when the shell set `NODE_ENV=production`.
    env: {
      NODE_ENV: "development",
      [FIXTURE_OUT_DIR_ENV]: path.join(os.tmpdir(), "component-fixture"),
      [FIXTURE_PREVIEW_IDENTITY_ENV]: fixturePreviewIdentity,
    },
    reuseExistingServer: false,
  };
}

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  // `*.spec.ts` expands to `**/*.spec.ts`, which would otherwise sweep in the
  // agent-testing, preview, and public-site specs. Those use their own servers
  // and configs rather than this component fixture server.
  testIgnore: ["agent-testing/**", "preview/**", "public-site/**"],
  fullyParallel: true,
  workers,
  // Both budgets are hang watchdogs on real signals (a navigation, a DOM
  // condition), not speed checks. Playwright's 30 s test and 5 s assertion
  // defaults failed healthy specs when the suite shared a loaded host
  // (docs/development/testing-guide.md, "Controlled time"). A spec that
  // measures latency asserts it explicitly.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Review validation retries a failed test once, so one timing miss on a busy
  // host does not fail the whole check. A test that passes on its retry is
  // still listed as flaky in the check's output; record it in
  // docs/tests/flaky-tests/ as for any flake.
  retries: process.env.ORKESTRATOR_REVIEW_VALIDATION === "1" ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  // Review validation streams one line per test and stops the run before its
  // deadline (tests/playwright-review-validation.ts).
  ...reviewValidationRunOptions("line"),
  // Prove the listener is the expected dev server or this run's preview before
  // workers start, then watch for it to stop answering.
  globalSetup: "./fixture-server-setup.ts",
  metadata: { fixturePreviewIdentity },
  outputDir: path.join(repositoryRoot, "output/playwright/test-results"),
  webServer: fixtureWebServer(),
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
