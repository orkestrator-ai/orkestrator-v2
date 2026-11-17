import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeElectronWithin } from "./design-electron-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";

const STEP_BUDGET_MS = 20_000;

async function settleWithin<T>(name: string, work: Promise<T>, budgetMs: number): Promise<T> {
  // The step keeps running after its budget; its late rejection is not news.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`In-page step "${name}" did not settle within ${budgetMs} ms`)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// No backend or production profile: two isolated renderer sessions (an in-memory
// one and a window slot's persistent partition) using the real installer.
test("real renderer sessions grant writes/fullscreen and deny other permissions and subframes", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ork-permissions-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const html = path.join(scratch, "index.html");
    await writeFile(
      html,
      '<!doctype html><title>Permission regression</title><iframe src="about:blank"></iframe>',
    );
    const entry = path.join(scratch, "main.ts");
    await writeFile(
      entry,
      `
      import { app, BrowserWindow } from "electron";
      import { installRendererPermissionPolicy } from ${JSON.stringify(path.join(root, "apps/desktop/electron/renderer-permissions.ts"))};
      app.setPath("userData", ${JSON.stringify(path.join(scratch, "profile"))});
      app.whenReady().then(async () => {
        for (const partition of ["renderer", "persist:orkestrator-renderer-2-0123456789abcdef"]) {
          const window = new BrowserWindow({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
          installRendererPermissionPolicy(window.webContents.session, ${JSON.stringify(pathToFileURL(html).href)});
          await window.loadFile(${JSON.stringify(html)});
        }
      });
    `,
    );
    const bundle = spawnSync(
      "bun",
      [
        "build",
        entry,
        "--target=node",
        "--external=electron",
        `--outfile=${path.join(scratch, "main.js")}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(bundle.status, bundle.stderr).toBe(0);
    app = await electron.launch({
      executablePath: path.join(root, "apps/desktop/node_modules/.bin/electron"),
      args: [...ELECTRON_TEST_SWITCHES, path.join(scratch, "main.js")],
      env: electronSpecEnvironment(process.env),
    });
    await expect.poll(() => app!.windows().length).toBe(2);
    for (const page of app.windows()) {
      await page.waitForLoadState();
      const contents = await app.browserWindow(page);
      // One executeJavaScript per await, each with its own budget, so a step
      // that never settles is named in the failure rather than hitting the
      // test's 120 s timeout inside one opaque script (to-do 8301, retired).
      const step = (name: string, source: string) =>
        settleWithin(
          name,
          contents.evaluate(
            (window, code) => window.webContents.executeJavaScript(code, true),
            source,
          ),
          STEP_BUDGET_MS,
        );
      await step(
        "clipboard write",
        `navigator.clipboard.writeText("permission-regression").then(() => true)`,
      );
      const fullscreen = await step(
        "enter fullscreen",
        `document.documentElement.requestFullscreen().then(() => !!document.fullscreenElement)`,
      );
      // Leaving fullscreen is only cleanup, so it is bounded. On a real macOS
      // display requestFullscreen() resolves while the window is still animating
      // into its own Space, and an exitFullscreen() issued during that animation
      // never settles. On mbp3 (macOS 27.2, Electron 45.2.3, 2026-11-17) it hung
      // 3 of 3 runs when called at once and settled 2 of 2 after a 5 s wait
      // (to-do 8301, retired; first bounded for to-do 2181). The app never calls
      // exitFullscreen(), so this is a test-only stall.
      await step(
        "leave fullscreen",
        `Promise.race([document.exitFullscreen(), new Promise((done) => setTimeout(done, 3000))]).then(() => true)`,
      );
      const result = await step(
        "permission queries and subframe write",
        `(async () => {
        const geo = await navigator.permissions.query({ name: "geolocation" });
        const notifications = await navigator.permissions.query({ name: "notifications" });
        const child = document.querySelector("iframe").contentWindow;
        const childNotifications = await child.navigator.permissions.query({ name: "notifications" });
        let childWrite = true;
        try { await child.navigator.clipboard.writeText("forbidden"); } catch { childWrite = false; }
        return { geo: geo.state, notifications: notifications.state, childNotifications: childNotifications.state, childWrite };
      })()`,
      );
      expect({ fullscreen, ...(result as object) }).toEqual({
        fullscreen: true,
        geo: "denied",
        notifications: "granted",
        childNotifications: "denied",
        childWrite: false,
      });
    }
  } finally {
    if (app) await closeElectronWithin(app);
    await rm(scratch, { recursive: true, force: true });
  }
});
