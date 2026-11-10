import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import {
  HEADLESS_ELECTRON_SWITCHES,
  withoutDisplay,
} from "../../apps/desktop/electron/runtime-profile";
import {
  NETWORK_CHANGED,
  STARTUP_FAILED_TEXT,
  watchElectronStartup,
} from "./electron-startup-recovery";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";
import {
  churnLoadUntilAborted,
  enterPrivateNetwork,
  serveModuleFanOut,
} from "./electron-startup-recovery-live-support";

/**
 * The Electron half of to-do 7062 task 2: a real headless Electron window,
 * launched and watched the way the Electron specs do (`watchElectronStartup`
 * straight after `electron.launch`, then `waitForTitle` on `firstWindow()`),
 * loses its module fan-out to a real `ERR_NETWORK_CHANGED` and recovers with
 * one reload. Run only by `electron-startup-recovery.integration.test.ts`,
 * inside `unshare --user --map-root-user --net`, so the interfaces it adds and
 * removes are this child's alone and no other build's Chromium sees them.
 */

enterPrivateNetwork(process.argv[2]);
const electronExecutable = process.argv[3];
if (!electronExecutable) throw new Error("Pass the Electron executable");

const title = "Startup recovered";
const server = await serveModuleFanOut(title);

const root = mkdtempSync(path.join(os.tmpdir(), "startup-recovery-electron-"));
const main = path.join(root, "main.cjs");
writeFileSync(
  main,
  [
    'const { app, BrowserWindow } = require("electron");',
    "app.whenReady().then(() => {",
    // Headless Ozone ignores this size: the window stays 1x1, as an app window
    // does until a spec sizes it, so the failure text is present but has no box.
    "  const window = new BrowserWindow({",
    "    width: 800,",
    "    height: 600,",
    "    webPreferences: { sandbox: true, contextIsolation: true },",
    "  });",
    // The window logs aborts as Chromium reports them, as the dev renderer's
    // module loads do.
    `  window.loadURL(${JSON.stringify(server.url.href)}).catch(() => undefined);`,
    "});",
    'app.on("window-all-closed", () => app.quit());',
    "",
  ].join("\n"),
);

const app = await electron.launch({
  executablePath: electronExecutable,
  // uid 0 inside the user namespace: Chromium refuses its own sandbox as root.
  args: [...ELECTRON_TEST_SWITCHES, ...HEADLESS_ELECTRON_SWITCHES, "--no-sandbox", main],
  env: electronSpecEnvironment(withoutDisplay(process.env)),
  timeout: 60_000,
});
try {
  const startup = watchElectronStartup(app);
  try {
    let networkChanged = false;
    app.context().on("requestfailed", (request) => {
      if (request.url().includes("/entry.js")) {
        networkChanged ||= request.failure()?.errorText === NETWORK_CHANGED;
      }
    });
    const window = await app.firstWindow({ timeout: 30_000 });
    await server.started;
    // Change only this child's interfaces while the window has modules in flight.
    // A burst that aborted nothing starts the load over, before any recovery.
    const churn = await churnLoadUntilAborted(
      () => networkChanged,
      async () => {
        const nextLoad = server.nextModuleRequest();
        // The held responses fill every connection Chromium allows to the
        // server, so a reload could not even send its request. Leaving for
        // about:blank cancels them and frees those connections first.
        await window.goto("about:blank");
        await window.goto(server.url.href, { waitUntil: "commit" });
        await nextLoad;
      },
    );
    if (!networkChanged) {
      throw new Error(
        `No actual ERR_NETWORK_CHANGED module failure observed (${JSON.stringify({
          ...churn,
          moduleRequests: server.moduleRequests(),
        })})`,
      );
    }
    await window.getByText(STARTUP_FAILED_TEXT).waitFor({ state: "attached", timeout: 10_000 });
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    server.release();
    const reloads = await startup.waitForTitle(window, title, { timeoutMs: 20_000 });
    // waitForTitle prints its own `[startup-recovery]` line; the result is the last line.
    process.stdout.write(
      `\n${JSON.stringify({
        networkChanged,
        reloads,
        moduleRequests: server.moduleRequests(),
        bursts: churn.bursts,
        interfaceChanges: churn.interfaceChanges,
        viewport,
      })}\n`,
    );
  } finally {
    startup.dispose();
  }
} finally {
  await app.close().catch(() => undefined);
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}
