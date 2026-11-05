/**
 * The log controls in the packaged app, which is what the efficiency report's
 * users run: the app's own executable, `app.asar`, the bundled backend and the
 * `file://` renderer. Build it first (see agent-testing.md, "Packaged-app
 * Electron spec"); `native-application-menu.yml` runs this on Linux and macOS.
 *
 * It runs on a disposable agent-test profile under a temporary root with an
 * allowlisted environment (packaged-electron-app.ts), and always headless on
 * Linux, so nothing reaches the signed-in desktop or the user's data directory.
 * Headless, the menu is read from Electron's own `Menu` object: no pixels of a
 * native menu bar are checked here.
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { openDesignWindow } from "./design-canvas-electron-journey";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { waitForStopped, withCleanup } from "../process-cleanup";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
} from "./packaged-electron-app";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const OPEN_DEVELOPER_TOOLS = "Open Developer Tools";

type PackagedRun = {
  app: ElectronApplication;
  window: Page;
  dataDir: string;
  mainOutput: () => string;
};

async function withPackagedApp(id: string, run: (packaged: PackagedRun) => Promise<void>) {
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:linux:unpacked:test\` first.`,
  ).toBe(true);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-log-controls-"));
  let app: ElectronApplication | null = null;
  // The renderer port is reserved for the profile's shape only: nothing serves it.
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: id,
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  const home = path.join(temporaryRoot, "home");
  await mkdir(home, { recursive: true });
  await withCleanup(async () => {
    app = await electron.launch({
      executablePath,
      args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
      cwd: temporaryRoot,
      env: packagedLaunchEnvironment(process.env, { home, profilePath }),
    });
    recordElectronDiagnostics(app);
    const launched = app;
    let mainOutput = "";
    const collect = (chunk: Buffer) => {
      mainOutput += chunk.toString("utf8");
    };
    app.process().stdout?.on("data", collect);
    app.process().stderr?.on("data", collect);
    const window = await openDesignWindow(launched, profile, {
      title: "native",
      timeoutMs: 60_000,
    });
    const runtime = await launched.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      userData: electronApp.getPath("userData"),
    }));
    expect(runtime.isPackaged).toBe(true);
    // The disposable profile, never the user's data directory.
    expect(runtime.userData).toBe(profile.dataDir);
    await run({
      app: launched,
      window,
      dataDir: profile.dataDir,
      mainOutput: () => mainOutput,
    });
  }, [
    async () => {
      let owned: number[] | undefined = app ? undefined : [];
      await withCleanup(async () => {
        if (app) {
          owned = electronProcessTree(app);
          await closeElectron(app, owned);
        }
      }, [
        async () => {
          // Retain the profile if forced termination could not prove the tree stopped.
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped(owned, 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
}

function helpLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!
      .items.find((item) => item.label === "Help" || item.role === "help")!
      .submenu!.items.map((item) => item.label),
  );
}

async function openDebugSettings(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Global settings", exact: true }).click();
  await window
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Debug", exact: true })
    .click();
}

/** The switch reloads the window, so the settings page has to be opened again. */
async function flipRendererDebugSwitch(window: Page): Promise<void> {
  const loaded = window.waitForEvent("load", { timeout: 60_000 });
  await window
    .getByRole("switch", { name: "Renderer debug logging for this window", exact: true })
    .click();
  await loaded;
  await expect(window.getByRole("button", { name: "Global settings", exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

test("the packaged app's Help offers Open Developer Tools only while this window's switch is on", async () => {
  test.setTimeout(240_000);
  await withPackagedApp("log-controls-menu", async ({ app, window }) => {
    expect(await helpLabels(app)).not.toContain(OPEN_DEVELOPER_TOOLS);
    await openDebugSettings(window);

    await flipRendererDebugSwitch(window);
    expect(await window.evaluate(() => localStorage.getItem("orkestrator:debug"))).toBe("1");
    await expect.poll(() => helpLabels(app)).toContain(OPEN_DEVELOPER_TOOLS);

    const devToolsOpen = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((win) => win.webContents.isDevToolsOpened()),
      );
    expect(await devToolsOpen()).toBe(false);
    await app.evaluate(({ BrowserWindow, Menu }, label) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Help" || item.role === "help")!
        .submenu!.items.find((item) => item.label === label)!
        .click({} as Electron.KeyboardEvent, win, win.webContents);
    }, OPEN_DEVELOPER_TOOLS);
    await expect.poll(devToolsOpen).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.closeDevTools();
    });
    await expect.poll(devToolsOpen).toBe(false);

    await openDebugSettings(window);
    await flipRendererDebugSwitch(window);
    expect(await window.evaluate(() => localStorage.getItem("orkestrator:debug"))).toBeNull();
    await expect.poll(() => helpLabels(app)).not.toContain(OPEN_DEVELOPER_TOOLS);
  });
});

test("the packaged app reverts raised log detail on the timer and leaves saving alone", async () => {
  // The check runs every minute, and it is the timer this waits for, not the start.
  test.setTimeout(240_000);
  await withPackagedApp("log-controls-expiry", async ({ window, dataDir, mainOutput }) => {
    const configFile = path.join(dataDir, "config.json");
    const stored = async () =>
      JSON.parse(await readFile(configFile, "utf8")) as {
        global: {
          logDetail?: { level: string; areaLevels: Record<string, string> };
          logDetailExpiresAt?: string;
          debugLogging?: boolean;
        };
      };
    await window.evaluate(async () => {
      await (globalThis as any).orkestrator.invoke("patch_global_config", {
        patch: {
          logDetail: { level: "info", areaLevels: { bridge: "debug" } },
          debugLogging: true,
        },
      });
    });
    const raised = await stored();
    expect(raised.global.logDetail?.areaLevels.bridge).toBe("debug");
    expect(Date.parse(raised.global.logDetailExpiresAt!)).toBeGreaterThan(Date.now());

    // Waiting out a day is not an option, and a client cannot set the expiry
    // through a write. The backend's config read follows the file's fingerprint,
    // so moving the stored expiry into the past is seen by its next check.
    raised.global.logDetailExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const replacement = `${configFile}.log-controls-spec`;
    await writeFile(replacement, JSON.stringify(raised, null, 2), { mode: 0o600 });
    await rename(replacement, configFile);

    await expect
      .poll(async () => (await stored()).global.logDetail, {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toEqual({ level: "info", areaLevels: {} });
    const reverted = await stored();
    expect(reverted.global.logDetailExpiresAt).toBeUndefined();
    expect(reverted.global.debugLogging).toBe(true);

    // The backend's line, through the relay to the desktop's own output.
    await expect.poll(mainOutput, { timeout: 30_000 }).toContain("[logging] policy.detail-expired");
    // The renderer's own read agrees, through the backend.
    const reread = await window.evaluate(async () => {
      const config = await (globalThis as any).orkestrator.invoke("get_config", {});
      return config.global.logDetail;
    });
    expect(reread).toEqual({ level: "info", areaLevels: {} });
  });
});
