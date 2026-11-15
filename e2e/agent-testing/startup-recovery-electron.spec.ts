import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withCleanup } from "../process-cleanup";
import { closeElectronWithin } from "./design-electron-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";
import {
  DEFAULT_STARTUP_RELOADS,
  MODULE_IMPORT_FAILED,
  NETWORK_CHANGED,
  STARTUP_FAILED_TEXT,
  watchElectronStartup,
} from "./electron-startup-recovery";

/**
 * The covering spec of to-do 7062 (retired) task 1, described in
 * docs/development/agent-testing.md ("Electron specs and their display"): a real Electron window, launched with the
 * specs' switches on whatever display the run has, and watched exactly as the
 * migrated specs watch theirs (`watchElectronStartup` straight after
 * `electron.launch()`, then `waitForTitle` on the window it opens).
 *
 * Its first load's module fan-out fails with Chromium's own
 * `net::ERR_NETWORK_CHANGED` (net error -21), returned by main's protocol
 * handler, so the console, the failed requests and the reload are Chromium's
 * and the helper's, not a stub's. The cause is injected rather than produced
 * by an interface change because this must run on a developer's Mac (mbp3,
 * 2026-11-15): changing an interface there needs root and would abort every
 * other Chromium on the host, the production Orkestrator's included. The
 * interface-change path itself is qualified on Linux inside a private network
 * namespace by `electron-startup-recovery.integration.test.ts`.
 *
 * The other two cases hold the helper to its narrow rule in the same real
 * window: a different network error is never reloaded, and a change that keeps
 * recurring fails after the reload budget instead of looping.
 */

const TITLE = "Startup recovered";
const ORIGIN = "http://startup-recovery.test";
const MODULES = 40;
/** Chromium net error codes (net/base/net_error_list.h). */
const NET_ERR_NETWORK_CHANGED = -21;
const NET_ERR_CONNECTION_REFUSED = -102;

interface FixtureMode {
  /** The net error the module loads of a document fail with. */
  error: number;
  /** How many documents (1-based) fail; later ones load. */
  failingDocuments: number;
}

/**
 * Main for the fixture: no window until the spec calls
 * `openStartupRecoveryWindow`, every `http:` request answered in main (no
 * socket, no DNS), so nothing outside the process is touched.
 * `globalThis.startupRecoveryDocuments` counts document loads for the spec.
 */
function fixtureMain(mode: FixtureMode): string {
  const page = `<!doctype html><title>Starting</title><script type="module">
    Promise.all(Array.from({ length: ${MODULES} }, (_, i) => import("/entry.js?i=" + i)))
      .then(() => { document.title = ${JSON.stringify(TITLE)}; })
      .catch((error) => {
        console.error(error.message);
        const heading = document.createElement("h1");
        heading.textContent = ${JSON.stringify(STARTUP_FAILED_TEXT)};
        document.body.append(heading);
      });
  </script><body></body>`;
  return [
    'const { app, BrowserWindow, protocol } = require("electron");',
    "globalThis.startupRecoveryDocuments = 0;",
    `const mode = ${JSON.stringify(mode)};`,
    `const page = ${JSON.stringify(page)};`,
    "app.whenReady().then(() => {",
    // The legacy intercept API is the one that can fail a request with a
    // chosen net error; `protocol.handle` can only answer or fail generically.
    '  protocol.interceptStringProtocol("http", (request, callback) => {',
    "    const { pathname } = new URL(request.url);",
    '    if (pathname === "/") {',
    "      globalThis.startupRecoveryDocuments += 1;",
    '      callback({ mimeType: "text/html", charset: "utf-8", data: page });',
    '    } else if (pathname === "/entry.js") {',
    "      if (globalThis.startupRecoveryDocuments <= mode.failingDocuments) {",
    "        callback({ error: mode.error });",
    "      } else {",
    '        callback({ mimeType: "text/javascript", data: "export const ready = true;" });',
    "      }",
    "    } else {",
    '      callback({ statusCode: 404, mimeType: "text/plain", data: "" });',
    "    }",
    "  });",
    // The app's own window loads its renderer only once its backend is up,
    // long after Playwright has attached. Served from memory a window opened
    // at launch would finish loading before then (and one created while
    // Playwright is still attaching was, once in 30 runs, never reported to
    // firstWindow()), so the spec opens it after its listeners are installed.
    "  globalThis.openStartupRecoveryWindow = () => {",
    "    const window = new BrowserWindow({",
    "      width: 800,",
    "      height: 600,",
    "      webPreferences: { sandbox: true, contextIsolation: true },",
    "    });",
    `    window.loadURL(${JSON.stringify(`${ORIGIN}/`)}).catch(() => undefined);`,
    "  };",
    "});",
    'app.on("window-all-closed", () => app.quit());',
    "",
  ].join("\n");
}

interface StartupRun {
  /** What `waitForTitle` resolved with, or the message it rejected with. */
  outcome: { reloads: number } | { error: string };
  documents: number;
  /** `requestfailed` error texts of the module loads, one of each. */
  moduleFailures: string[];
  consoleImportFailures: number;
}

async function runStartup(mode: FixtureMode): Promise<StartupRun> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-startup-recovery-"));
  let app: ElectronApplication | undefined;
  let run: StartupRun | undefined;
  await withCleanup(async () => {
    const main = path.join(directory, "main.cjs");
    await writeFile(main, fixtureMain(mode));
    app = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        "--lang=en-US",
        `--user-data-dir=${path.join(directory, "profile")}`,
        main,
      ],
      env: electronSpecEnvironment(process.env, { ELECTRON_RUN_AS_NODE: undefined }),
      timeout: 60_000,
    });
    // Straight after launch, as the migrated specs do: in the app the first
    // load's aborts can arrive before firstWindow() resolves, and here
    // before the "window" event does.
    const startup = watchElectronStartup(app);
    const moduleFailures = new Set<string>();
    let consoleImportFailures = 0;
    app.context().on("requestfailed", (request) => {
      if (request.url().includes("/entry.js")) {
        moduleFailures.add(request.failure()?.errorText ?? "");
      }
    });
    app.context().on("console", (message) => {
      if (message.text().includes(MODULE_IMPORT_FAILED)) consoleImportFailures += 1;
    });
    try {
      const opened = app.waitForEvent("window", { timeout: 30_000 });
      await app.evaluate(() =>
        (globalThis as { openStartupRecoveryWindow?: () => void }).openStartupRecoveryWindow?.(),
      );
      const window = await opened;
      let outcome: StartupRun["outcome"];
      try {
        outcome = { reloads: await startup.waitForTitle(window, TITLE, { timeoutMs: 45_000 }) };
      } catch (error) {
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      const documents = await app.evaluate(
        () => (globalThis as { startupRecoveryDocuments?: number }).startupRecoveryDocuments ?? 0,
      );
      run = { outcome, documents, moduleFailures: [...moduleFailures], consoleImportFailures };
    } finally {
      startup.dispose();
    }
  }, [
    async () => void (await closeElectronWithin(app)),
    () => rm(directory, { recursive: true, force: true }),
  ]);
  await test.info().attach("startup-recovery-run", {
    body: JSON.stringify({ platform: process.platform, mode, ...run }),
    contentType: "application/json",
  });
  return run!;
}

test("a window whose first load lost its modules to ERR_NETWORK_CHANGED recovers with one reload", async () => {
  const run = await runStartup({ error: NET_ERR_NETWORK_CHANGED, failingDocuments: 1 });
  expect(run.outcome).toEqual({ reloads: 1 });
  expect(run.documents).toBe(2);
  expect(run.moduleFailures).toEqual([NETWORK_CHANGED]);
  expect(run.consoleImportFailures).toBeGreaterThan(0);
  expect(test.info().annotations).toContainEqual({
    type: "startup-recovery",
    description: `renderer start reloaded 1x after ${NETWORK_CHANGED}`,
  });
});

test("a window whose modules failed for another network error is not reloaded", async () => {
  const run = await runStartup({ error: NET_ERR_CONNECTION_REFUSED, failingDocuments: 1 });
  expect(run.outcome).toEqual({
    error: expect.stringContaining("not a network-change module failure"),
  });
  expect(run.documents).toBe(1);
  expect(run.moduleFailures).toEqual(["net::ERR_CONNECTION_REFUSED"]);
  expect(test.info().annotations.map((annotation) => annotation.type)).not.toContain(
    "startup-recovery",
  );
});

test("a network change that hits every load fails after the reload budget", async () => {
  const run = await runStartup({ error: NET_ERR_NETWORK_CHANGED, failingDocuments: 100 });
  expect(run.outcome).toEqual({
    error: expect.stringContaining(`still failing after ${DEFAULT_STARTUP_RELOADS} reloads`),
  });
  expect(run.documents).toBe(DEFAULT_STARTUP_RELOADS + 1);
  expect(run.moduleFailures).toEqual([NETWORK_CHANGED]);
});
