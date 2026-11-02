import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The boundary docs/architecture/logging.md promises, through the real Electron
 * main process and renderer: with the renderer's level raised, its logger lines
 * reach the browser console and stop there, and the startup markers are what
 * crosses.
 *
 * It reads the main process's console, because that is what the saved log is made
 * of: `installProductionApplicationLogging` tees those same calls into the file,
 * as application-logging.test.ts proves, and is installed only for the production
 * flavor, which no test may run against the real data directory.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);
}

const count = (text: string, line: string): number => text.split(line).length - 1;

async function emitDebugProbes(window: Page): Promise<boolean> {
  return window.evaluate(
    async (modulePath) => {
      const { createLogger } = await import(/* @vite-ignore */ modulePath);
      const webLog = createLogger("web.window");
      const terminalLog = createLogger("terminal");
      webLog.debug("error.unhandled", { scope: "debug-boundary-probe" });
      terminalLog.debug("connect.called", { scope: "debug-boundary-probe" });
      return webLog.isEnabled("debug") && terminalLog.isEnabled("debug");
    },
    `/@fs${path.join(repositoryRoot, "packages/protocol/src/logger.ts")}`,
  );
}

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a real window sends its startup markers to the main process and none of its logger lines", async () => {
  test.setTimeout(240_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-log-boundary-"));
  let vite: ChildProcess | null = null;
  let launchedApp: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "renderer-log-boundary",
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
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  try {
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
      },
    });
    ownProcessGroup(vite);
    recordProcessOutput("vite", vite);
    await waitForUrl(rendererUrl);
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        path.join(repositoryRoot, "apps", "desktop", "dist", "electron", "main.js"),
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        APPIMAGE: "",
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      },
    });
    recordElectronDiagnostics(app);
    launchedApp = app;
    let mainConsole = "";
    const collect = (chunk: Buffer) => {
      mainConsole += chunk.toString("utf8");
    };
    app.process().stdout?.on("data", collect);
    app.process().stderr?.on("data", collect);
    dismissStartupDialogs(app);
    await expect
      .poll(() => app.windows().some((page) => page.url().startsWith(rendererUrl)), {
        timeout: 60_000,
      })
      .toBe(true);
    const window = app.windows().find((page) => page.url().startsWith(rendererUrl)) as Page;
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect(window.getByRole("button", { name: "Global settings", exact: true })).toBeVisible({
      timeout: 60_000,
    });

    const browserConsole: { type: string; text: string }[] = [];
    window.on("console", (message) =>
      browserConsole.push({ type: message.type(), text: message.text() }),
    );
    const debugProbes = () =>
      browserConsole.filter((message) => message.text.includes("scope=debug-boundary-probe"));

    expect(await emitDebugProbes(window)).toBe(false);
    expect(debugProbes()).toEqual([]);

    // The preference takes effect only on reload, in the logger the app uses.
    await window.evaluate(() => localStorage.setItem("orkestrator:debug", "1"));
    expect(await emitDebugProbes(window)).toBe(false);
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect(window.getByRole("button", { name: "Global settings", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(await emitDebugProbes(window)).toBe(true);
    await expect.poll(debugProbes).toEqual([
      { type: "debug", text: "[web.window] error.unhandled scope=debug-boundary-probe" },
      { type: "debug", text: "[terminal] connect.called scope=debug-boundary-probe" },
    ]);

    // A line in each migrated form, and text close to a marker. Reloading after
    // them orders the check: a marker from the next load comes after these in the
    // main process, so once it is saved these have been seen and refused.
    await window.evaluate(() => {
      console.error("[web.window] error.unhandled error.name=Error");
      console.warn("[terminal] input.undelivered scope=probe");
      console.error("[DesktopStartup] ready marker-with-more-text");
      localStorage.removeItem("orkestrator:debug");
    });
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect(window.getByRole("button", { name: "Global settings", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(await emitDebugProbes(window)).toBe(false);
    expect(debugProbes()).toHaveLength(2);

    await expect
      .poll(() => count(mainConsole, "[DesktopStartup] ready"), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3);
    expect(count(mainConsole, "[DesktopStartup] checking")).toBeGreaterThanOrEqual(3);
    expect(mainConsole).not.toContain("[web.");
    expect(mainConsole).not.toContain("[terminal");
    expect(mainConsole).not.toContain("marker-with-more-text");
    expect(mainConsole).not.toContain("debug-boundary-probe");
    expect(browserConsole.some((message) => message.text === "[DesktopStartup] ready")).toBe(true);

    // The real settings UI must not offer controls for those renderer areas.
    await window.getByRole("button", { name: "Global settings", exact: true }).click();
    await window
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Debug", exact: true })
      .click();
    await window.getByRole("button", { name: "Levels by area" }).click();
    await expect(
      window.getByRole("combobox", { name: "Log level for bridge", exact: true }),
    ).toHaveCount(1);
    await expect(
      window.getByRole("combobox", { name: "Log level for backend.activity", exact: true }),
    ).toHaveCount(1);
    await expect(
      window.getByRole("combobox", { name: /^Log level for (web\.|terminal(?:\.|$))/ }),
    ).toHaveCount(0);
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
