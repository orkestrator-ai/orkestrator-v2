import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { closeElectronWithin, electronProcessTree } from "./design-electron-cleanup";
import { processAlive, signalProcess, waitForStopped } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";

test("bounded cleanup stops a real Electron close blocked by before-quit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "electron-close-regression-"));
  const fixture = path.join(directory, "main.cjs");
  const attempted = path.join(directory, "quit-attempted");
  const helperFile = path.join(directory, "helper-pid");
  let owned: number[] = [];
  try {
    await writeFile(
      fixture,
      `
      const { app, BrowserWindow } = require("electron");
      const fs = require("node:fs");
      const helper = require("node:child_process").spawn(
        process.execPath, ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      );
      fs.writeFileSync(${JSON.stringify(helperFile)}, String(helper.pid));
      app.on("before-quit", (event) => {
        event.preventDefault();
        fs.writeFileSync(${JSON.stringify(attempted)}, "blocked");
      });
      app.whenReady().then(() => new BrowserWindow({ show: false }));
    `,
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
    }
    const app = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        "--no-sandbox",
        `--user-data-dir=${path.join(directory, "profile")}`,
        fixture,
      ],
      env,
    });
    owned = electronProcessTree(app);
    const helper = Number(await readFile(helperFile, "utf8"));
    expect(owned).toContain(helper);
    const started = Date.now();
    expect(await closeElectronWithin(app, 500)).toBe("killed");
    expect(Date.now() - started).toBeLessThan(10_000);
    // Proves the real Playwright close reached Electron and was prevented.
    expect(await readFile(attempted, "utf8")).toBe("blocked");
    expect(owned.some(processAlive)).toBe(false);
    await test.info().attach("bounded-cleanup", {
      body: JSON.stringify({ platform: process.platform, owned, helper, stopped: true }),
      contentType: "application/json",
    });
  } finally {
    for (const pid of owned.filter(processAlive)) signalProcess(pid, "SIGKILL");
    await waitForStopped(owned, 5_000);
    // Windows may release Chromium's SQLite handles just after the process
    // exit probe succeeds. Keep profile removal bounded while those close.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
