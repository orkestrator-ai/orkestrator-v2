import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The boundary docs/architecture/logging.md promises, through the real Electron
 * main process, renderer and log file: with logs being saved and the renderer's
 * level raised, renderer logger lines reach the browser console and stop there,
 * and the startup markers are what crosses.
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

async function savedLog(dataDir: string): Promise<string> {
  const directory = path.join(dataDir, "logs");
  const files = await readdir(directory).catch(() => [] as string[]);
  const texts = await Promise.all(
    files
      .filter((file) => file.endsWith(".log"))
      .map((file) => readFile(path.join(directory, file), "utf8")),
  );
  return texts.join("\n");
}

const count = (text: string, line: string): number => text.split(line).length - 1;

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a real window saves its startup markers and none of its logger lines", async () => {
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
  const configPath = path.join(profile.dataDir, "config.json");
  const config = await readFile(configPath, "utf8")
    .then((text) => JSON.parse(text) as { global?: Record<string, unknown> })
    .catch(() => ({ global: {} }));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, global: { ...config.global, debugLogging: true } }),
  );
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
    dismissStartupDialogs(app);
    await expect
      .poll(() => app.windows().some((page) => page.url().startsWith(rendererUrl)), {
        timeout: 60_000,
      })
      .toBe(true);
    const window = app.windows().find((page) => page.url().startsWith(rendererUrl)) as Page;
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });

    const browserConsole: string[] = [];
    window.on("console", (message) => browserConsole.push(message.text()));

    // Raises the renderer's level, so its debug lines are written as well.
    await window.evaluate(() => localStorage.setItem("orkestrator:debug", "1"));
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect
      .poll(() => browserConsole.filter((line) => /^\[(web\.|terminal)/.test(line)).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // A line in each migrated form, and text close to a marker. Reloading after
    // them orders the check: a marker from the next load comes after these in the
    // main process, so once it is saved these have been seen and refused.
    await window.evaluate(() => {
      console.error("[web.window] error.unhandled error.name=Error");
      console.warn("[terminal] input.undelivered scope=probe");
      console.error("[DesktopStartup] ready marker-with-more-text");
    });
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });

    await expect
      .poll(async () => count(await savedLog(profile.dataDir), "[DesktopStartup] ready"), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(3);
    const saved = await savedLog(profile.dataDir);
    expect(count(saved, "[DesktopStartup] checking")).toBeGreaterThanOrEqual(3);
    expect(saved).not.toContain("[web.");
    expect(saved).not.toContain("[terminal");
    expect(saved).not.toContain("marker-with-more-text");
    expect(browserConsole).toContain("[DesktopStartup] ready");
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
