import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeElectronWithin } from "./design-electron-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";

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
    });
    await expect.poll(() => app!.windows().length).toBe(2);
    for (const page of app.windows()) {
      await page.waitForLoadState();
      const contents = await app.browserWindow(page);
      const result = await contents.evaluate(async (window) =>
        window.webContents.executeJavaScript(
          `(async () => {
        await navigator.clipboard.writeText("permission-regression");
        await document.documentElement.requestFullscreen();
        const fullscreen = !!document.fullscreenElement;
        await document.exitFullscreen();
        const geo = await navigator.permissions.query({ name: "geolocation" });
        const notifications = await navigator.permissions.query({ name: "notifications" });
        const child = document.querySelector("iframe").contentWindow;
        const childNotifications = await child.navigator.permissions.query({ name: "notifications" });
        let childWrite = true;
        try { await child.navigator.clipboard.writeText("forbidden"); } catch { childWrite = false; }
        return { fullscreen, geo: geo.state, notifications: notifications.state, childNotifications: childNotifications.state, childWrite };
      })()`,
          true,
        ),
      );
      expect(result).toEqual({
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
