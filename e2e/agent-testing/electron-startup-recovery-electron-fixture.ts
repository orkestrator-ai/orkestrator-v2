import { execFileSync } from "node:child_process";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The Electron half of to-do 7062 task 2: a real headless Electron window,
 * launched and watched the way the Electron specs do (`watchElectronStartup`
 * straight after `electron.launch`, then `waitForTitle` on `firstWindow()`),
 * loses its module fan-out to a real `ERR_NETWORK_CHANGED` and recovers with
 * one reload. Run only by `electron-startup-recovery.integration.test.ts`,
 * inside `unshare --user --map-root-user --net`, so the interfaces it adds and
 * removes are this child's alone and no other build's Chromium sees them.
 */

// Refuse to change interfaces unless unshare gave us a private network namespace.
if (!process.argv[2] || readlinkSync("/proc/self/ns/net") === process.argv[2]) {
  throw new Error("Startup qualification requires a private network namespace");
}
const electronExecutable = process.argv[3];
if (!electronExecutable) throw new Error("Pass the Electron executable");
const ip = (...args: string[]) => execFileSync("ip", args, { stdio: "pipe" });
ip("link", "set", "lo", "up");

let moduleRequests = 0;
let allowModules = false;
let moduleStarted!: () => void;
const started = new Promise<void>((resolve) => (moduleStarted = resolve));
const title = "Startup recovered";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/entry.js") {
      moduleRequests += 1;
      moduleStarted();
      if (!allowModules) await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("export const ready = true", {
        headers: { "Content-Type": "text/javascript" },
      });
    }
    // The renderer's own failure path: log the rejected import, then show
    // the startup failure text, as renderer-entry does.
    return new Response(
      `<title>Starting</title><script type="module">
        Promise.all(Array.from({length: 1000}, (_, i) => import('/entry.js?i=' + i)))
        .then(() => { document.title = ${JSON.stringify(title)}; }).catch(error => {
          console.error(error.message);
          document.body.textContent = ${JSON.stringify(STARTUP_FAILED_TEXT)};
        });
      </script><body></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});

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
    await started;
    // Change only this child's interfaces while the window has modules in flight.
    for (let attempt = 0; attempt < 200 && !networkChanged; attempt += 1) {
      if (attempt % 2 === 0) {
        ip("link", "add", "churn-test", "type", "bridge");
        ip("addr", "add", "192.0.3.1/24", "dev", "churn-test");
        ip("link", "set", "churn-test", "up");
      } else {
        ip("link", "del", "churn-test");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!networkChanged) throw new Error("No actual ERR_NETWORK_CHANGED module failure observed");
    await window.getByText(STARTUP_FAILED_TEXT).waitFor({ state: "attached", timeout: 10_000 });
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    allowModules = true;
    const reloads = await startup.waitForTitle(window, title, { timeoutMs: 20_000 });
    // waitForTitle prints its own `[startup-recovery]` line; the result is the last line.
    process.stdout.write(
      `\n${JSON.stringify({ networkChanged, reloads, moduleRequests, viewport })}\n`,
    );
  } finally {
    startup.dispose();
  }
} finally {
  await app.close().catch(() => undefined);
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
