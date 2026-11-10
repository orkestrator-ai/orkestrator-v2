import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { buildLocalBridges } from "../../apps/desktop/scripts/dev/bridge-builds";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import { electronSpecEnvironment } from "./electron-spec-environment";

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

test("rejected second launch leaves crash markers intact and immediate exit flushes without will-quit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-essential-native-"));
  const fixture = path.join(root, "main.ts");
  const bundle = path.join(root, "main.cjs");
  const dataDir = path.join(root, "data");
  const ready = path.join(root, "ready");
  const control = path.join(root, "control");
  const file = path.join(dataDir, "logs", "essential", "essential.jsonl");
  const children: ChildProcess[] = [];
  const closed = new Map<ChildProcess, Promise<number | null>>();
  const launch = () => {
    // Playwright's `electron.launch` adds --no-sandbox on Linux; this bare spawn
    // must too. Where unprivileged user namespaces are refused (GitHub's
    // ubuntu-latest, through AppArmor), Chromium falls back to the setuid
    // `chrome-sandbox` helper, which an npm install never makes root-owned, and
    // aborts before `ready`. This fixture loads no renderer, so nothing it
    // asserts depends on the sandbox.
    const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
    const child = spawn(electronExecutable, [...ELECTRON_TEST_SWITCHES, ...sandbox, bundle], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: electronSpecEnvironment(process.env, { ELECTRON_RUN_AS_NODE: undefined }),
    });
    ownProcessGroup(child);
    recordProcessOutput("essential-lifecycle", child);
    children.push(child);
    closed.set(
      child,
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
    );
    return child;
  };
  try {
    // Same production admission and native exit helpers, with no backend,
    // renderer, credentials or production profile. A file requests exit inside
    // Electron itself, so a launcher wrapper cannot orphan the native process.
    await writeFile(
      fixture,
      `
      import { app } from "electron";
      import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
      import { claimDesktopLogging, exitWithEssentialLog } from ${JSON.stringify(path.join(packageRoot, "electron/essential-logging.ts"))};
      import { configureLogger, createLogger } from ${JSON.stringify(path.join(repositoryRoot, "packages/protocol/src/logger.ts"))};
      app.setPath("userData", ${JSON.stringify(dataDir)});
      app.on("window-all-closed", () => {});
      configureLogger({ sink: () => {} });
      const { isPrimaryInstance, essentialLog } = claimDesktopLogging(app, app.getPath("userData"));
      if (isPrimaryInstance) {
        app.on("will-quit", () => writeFileSync(${JSON.stringify(path.join(root, "will-quit"))}, ""));
        app.whenReady().then(async () => {
          await essentialLog.flush();
          writeFileSync(${JSON.stringify(ready)}, "");
          setInterval(() => {
            const file = ${JSON.stringify(control)};
            if (!existsSync(file)) return;
            const action = readFileSync(file, "utf8");
            if (action !== "crash" && action !== "exit") return;
            unlinkSync(file);
            if (action === "crash") { process.kill(process.pid, "SIGKILL"); return; }
            createLogger("backend").info("shutdown.finished", { code: 42 });
            exitWithEssentialLog(app, essentialLog, 0);
          }, 10);
        });
      }
    `,
    );
    const build = spawnSync(
      "bun",
      [
        "build",
        fixture,
        "--target=node",
        "--format=cjs",
        "--external=electron",
        "--outfile",
        bundle,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const waitReady = () =>
      expect
        .poll(
          () =>
            stat(ready).then(
              () => true,
              () => false,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
    const primary = launch();
    await waitReady();
    const before = await readFile(file, "utf8");
    expect(before).toContain('"event":"essential.started"');
    const secondary = launch();
    expect(await closed.get(secondary)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(before);

    await writeFile(control, "crash");
    await closed.get(primary);
    await rm(ready);
    const next = launch();
    await waitReady();
    const restarted = await readFile(file, "utf8");
    expect(count(restarted, '"event":"essential.started"')).toBe(2);
    expect(restarted).not.toContain('"event":"essential.stopped"');

    await writeFile(control, "exit");
    expect(await closed.get(next)).toBe(0);
    expect(await readFile(file, "utf8")).toContain('"code":42');
    await expect(stat(path.join(root, "will-quit"))).rejects.toThrow();
  } finally {
    for (const child of children) await stopProcessGroup(child);
    await rm(root, { recursive: true, force: true });
  }
});

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
  // Build the local bridges, as `dev:test` does before it starts a profile.
  // This profile provisions no agent toolchain and an agent-test backend never
  // falls back to PATH, so a built Cursor bridge is its only agent platform.
  // Without one (a fresh checkout or CI) the window opens the blocking "AI CLI
  // Required" alert, which hides the workspace this spec drives.
  const bridges = buildLocalBridges(repositoryRoot);
  expect(bridges.ok, bridges.output).toBe(true);
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
      env: electronSpecEnvironment(process.env, {
        APPIMAGE: "",
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        // No startup container-to-host probe: its container changes an interface
        // while the renderer is loading, and Chromium aborts the loopback module
        // requests with ERR_NETWORK_CHANGED (flake 2340).
        ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
      }),
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
    const previewDir = path.join(repositoryRoot, "output", "visual-previews");
    await mkdir(previewDir, { recursive: true });
    await window.screenshot({ path: path.join(previewDir, "e16-menu-before-devtools.png") });
    // Invoke the real createMenu action while a different, non-opted-in window
    // has focus. The globally offered action must still open opted-in contents.
    await app.evaluate(async ({ BrowserWindow, Menu }) => {
      const extra = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
      await extra.loadURL("about:blank");
      extra.focus();
      const help = Menu.getApplicationMenu()!.items.find(
        (item) => item.label === "Help" || item.role === "help",
      )!;
      const action = help.submenu!.items.find((item) => item.label === "Open Developer Tools")!;
      action.click();
      extra.close();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((win) => win.webContents.isDevToolsOpened()),
        ),
      )
      .toBe(true);
    const inspectorImage = await app.evaluate(async ({ BrowserWindow }) => {
      const inspector = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.isDevToolsOpened(),
      )!.webContents.devToolsWebContents!;
      return (await inspector.capturePage()).toPNG().toString("base64");
    });
    await writeFile(
      path.join(previewDir, "e16-menu-after-devtools.png"),
      Buffer.from(inspectorImage, "base64"),
    );
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.closeDevTools();
    });

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
    // The shared `terminal` area stays: its backend sites follow live policy.
    await expect(
      window.getByRole("combobox", { name: /^Log level for (web\.|terminal\.)/ }),
    ).toHaveCount(0);

    // The essential log, through the real relay: this profile has saving off, the
    // desktop owns the file and the backend's own line reached it over stdio.
    await expect(window.getByText(/always kept, even with this off/)).toBeVisible();
    const essentialFile = path.join(profile.dataDir, "logs", "essential", "essential.jsonl");
    const essential = () => readFile(essentialFile, "utf8").catch(() => "");
    await expect.poll(essential, { timeout: 30_000 }).toContain('"event":"starting"');
    expect(await essential()).toContain('"owner":"desktop"');
    expect((await stat(essentialFile)).mode & 0o777).toBe(0o600);
    // Use the renderer's actual ring and scheduled uploader, never invoke the
    // recording command directly. Only metadata may cross the real relay.
    await window.evaluate(async () => {
      const ReactModule = await import(
        /* @vite-ignore */ String("/node_modules/.vite/deps/react.js")
      );
      const React = ReactModule.default ?? ReactModule;
      const ClientModule = await import(
        /* @vite-ignore */ String("/node_modules/.vite/deps/react-dom_client.js")
      );
      const { createRoot } = ClientModule.default ?? ClientModule;
      const { createReactRootErrorOptions } = await import(
        /* @vite-ignore */ String("/src/lib/react-root-errors.ts")
      );
      const host = document.createElement("div");
      document.body.append(host);
      class Boundary extends React.Component {
        static diagnosticBoundary = "message-row";
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          return this.state.failed ? "Caught diagnostic probe" : this.props.children;
        }
      }
      function Broken() {
        const error = new TypeError("synthetic-private-renderer-message");
        error.stack = "synthetic-private-renderer-stack";
        throw error;
      }
      const root = createRoot(host, createReactRootErrorOptions());
      root.render(React.createElement(Boundary, null, React.createElement(Broken)));
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!host.textContent?.includes("Caught diagnostic probe")) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(host, { childList: true, subtree: true });
      });
      root.unmount();
      host.remove();
    });
    // Reload immediately after the caught failure, before the old ten-second interval.
    await window.reload();
    await expect.poll(essential, { timeout: 30_000 }).toContain('"event":"error.recorded"');
    // Let the reloaded page finish starting. Closing it mid-request throws in the
    // main process and loses the shutdown lines checked below (6303).
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect(window.getByRole("button", { name: "Global settings", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const records = (await essential())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failure = records.find(
      (record) => record.area === "renderer-errors" && record.event === "error.recorded",
    );
    expect(failure.fields).toMatchObject({
      errorClass: "TypeError",
      boundary: "message-row",
      route: "window",
      count: 1,
    });
    expect(Object.keys(failure.fields).sort()).toEqual([
      "boundary",
      "count",
      "errorClass",
      "fingerprint",
      "route",
    ]);
    expect(failure.fields.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(await essential()).not.toContain("synthetic-private-renderer");

    await closeElectronWithin(launchedApp);
    launchedApp = null;
    await expect.poll(essential, { timeout: 10_000 }).toContain('"event":"essential.stopped"');
    expect(await essential()).toContain('"event":"shutdown.finished"');
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
