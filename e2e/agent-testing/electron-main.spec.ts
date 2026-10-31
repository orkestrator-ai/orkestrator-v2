import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import type { OrkestratorElectronApi } from "../../apps/desktop/electron/preload-api";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import {
  writeRemoteRelaunchMarker,
  readRemoteRelaunchMarker,
} from "../../apps/desktop/electron/remote-relaunch";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

function backendChildPid(electronPid: number): number | null {
  const processes = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (processes.status !== 0) return null;
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== electronPid) continue;
    if (match[3].includes("apps/backend/src/main.ts")) return Number(match[1]);
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
}

async function captureBootstrapRendering(app: ElectronApplication) {
  return app.evaluate(async ({ app: electronApp, BrowserWindow, screen }) => {
    const bootstrapWindow = BrowserWindow.getAllWindows()[0];
    if (!bootstrapWindow) throw new Error("Bootstrap window was not created");
    try {
      // A tiling compositor controls the final surface. Giving the real
      // window a different size exercises the same resize and repaint path.
      bootstrapWindow.setSize(900, 700);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const bounds = bootstrapWindow.getBounds();
      const [contentWidth, contentHeight] = bootstrapWindow.getContentSize();
      const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
      const captureSize = (await bootstrapWindow.webContents.capturePage()).getSize();
      const layout = (await bootstrapWindow.webContents.executeJavaScript(`(() => {
          const main = document.querySelector("main").getBoundingClientRect();
          const body = document.body.getBoundingClientRect();
          return {
            innerWidth,
            innerHeight,
            main: { left: main.left, right: main.right, top: main.top, bottom: main.bottom },
            body: { width: body.width, height: body.height },
          };
        })()`)) as {
        innerWidth: number;
        innerHeight: number;
        main: { left: number; right: number; top: number; bottom: number };
        body: { width: number; height: number };
      };
      return {
        bounds,
        captureSize,
        contentWidth,
        contentHeight,
        layout,
        maximumSize: bootstrapWindow.getMaximumSize(),
        minimumSize: bootstrapWindow.getMinimumSize(),
        ozonePlatform: electronApp.commandLine.getSwitchValue("ozone-platform"),
        resizable: bootstrapWindow.isResizable(),
        scaleFactor,
      };
    } finally {
      bootstrapWindow.destroy();
    }
  });
}

function expectResponsiveBootstrapRendering(
  rendering: Awaited<ReturnType<typeof captureBootstrapRendering>>,
): void {
  expect(rendering.resizable).toBe(true);
  expect(rendering.minimumSize).toEqual([0, 0]);
  expect(rendering.maximumSize).toEqual([0, 0]);
  expect(rendering.bounds.width).toBeGreaterThan(520);
  expect(rendering.bounds.height).toBeGreaterThan(300);
  expect(Math.abs(rendering.layout.innerWidth - rendering.contentWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(rendering.layout.innerHeight - rendering.contentHeight)).toBeLessThanOrEqual(2);
  expect(rendering.layout.body.width).toBeCloseTo(rendering.layout.innerWidth, 0);
  expect(rendering.layout.body.height).toBeCloseTo(rendering.layout.innerHeight, 0);
  expect((rendering.layout.main.left + rendering.layout.main.right) / 2).toBeCloseTo(
    rendering.layout.innerWidth / 2,
    0,
  );
  expect(rendering.layout.main.top).toBeGreaterThanOrEqual(0);
  expect(rendering.layout.main.bottom).toBeLessThanOrEqual(rendering.layout.innerHeight);
  expect(rendering.captureSize).toEqual({
    width: Math.round(rendering.contentWidth * rendering.scaleFactor),
    height: Math.round(rendering.contentHeight * rendering.scaleFactor),
  });
}

test.beforeAll(() => {
  // Bundle exactly as production and the dev launcher do. A `tsc` emit leaves
  // workspace imports pointing at raw `.ts` sources Electron cannot run.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

type DesktopRecoveryScenario = "close" | "restart" | "remote" | "planned" | "renderer";

async function testIndependentWindows(
  nicknamesOnly = false,
  failure?: DesktopRecoveryScenario,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-smoke-"));
  let vite: ChildProcess | null = null;
  let launchedApp: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-smoke",
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
    dismissStartupDialogs(app);
    // Startup can briefly create a bootstrap window, and development opens
    // detached DevTools. Select the application document explicitly.
    await expect
      .poll(() => app.windows().some((page) => page.url().startsWith(rendererUrl)), {
        timeout: 60_000,
      })
      .toBe(true);
    const window = app.windows().find((page) => page.url().startsWith(rendererUrl));
    if (!window) throw new Error("Main renderer window was not created");
    // index.html's title stays until Vite serves and runs renderer-entry; under
    // host load that startup takes longer than expect's 5 s default.
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.getTitle() ??
            null,
        ),
      )
      .toBe(`${profile.electronTitle} — Local`);

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    expect(userData).toBe(profile.dataDir);
    const greeting = await window.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          orkestrator: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
        }
      ).orkestrator;
      return api.invoke<string>("greet", { name: "Electron smoke" });
    });
    expect(greeting).toContain("Hello, Electron smoke");
    await window
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              clipboard: { writeText(value: string): Promise<void>; readText(): Promise<string> };
            };
          }
        ).orkestrator;
        await api.clipboard.writeText("orkestrator-electron-smoke");
        return api.clipboard.readText();
      })
      .then((value) => expect(value).toBe("orkestrator-electron-smoke"));
    // Electron 44 replaced readImage/writeImage with ClipboardItem payloads;
    // round-trip a real PNG through the main-process handlers.
    await window
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              clipboard: {
                writeImage(dataUrl: string): Promise<void>;
                readImage(): Promise<{ width: number; height: number; dataUrl?: string } | null>;
              };
            };
          }
        ).orkestrator;
        const canvas = document.createElement("canvas");
        canvas.width = 3;
        canvas.height = 2;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#28231f";
        context.fillRect(0, 0, 3, 2);
        await api.clipboard.writeImage(canvas.toDataURL("image/png"));
        const image = await api.clipboard.readImage();
        return image && { width: image.width, height: image.height, dataUrl: image.dataUrl };
      })
      .then((image) => {
        expect(image).toMatchObject({ width: 3, height: 2 });
        expect(image?.dataUrl).toMatch(/^data:image\/png;base64,/);
      });
    if (process.platform === "darwin") {
      // Native apps commonly put only public.tiff on NSPasteboard. Seed the
      // actual OS format, not an Electron ClipboardItem that might also add PNG.
      const png = await window.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 3;
        canvas.height = 2;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#d03050";
        context.fillRect(0, 0, 3, 2);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const swiftFile = path.join(temporaryRoot, "clipboard-tiff.swift");
      await writeFile(
        swiftFile,
        `import AppKit
let png = Data(base64Encoded: CommandLine.arguments[1])!
let image = NSBitmapImageRep(data: png)!
let tiff = image.representation(using: .tiff, properties: [:])!
let board = NSPasteboard.general
board.clearContents()
board.declareTypes([.tiff], owner: nil)
guard board.setData(tiff, forType: .tiff),
      board.types?.contains(.tiff) == true,
      board.types?.contains(.png) == false else { exit(1) }
print("public.tiff")
`,
      );
      const seeded = spawnSync("/usr/bin/swift", [swiftFile, png], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(seeded.stdout.trim()).toBe("public.tiff");
      const formats = await app.evaluate(async ({ clipboard }) =>
        (await clipboard.read()).flatMap((item) => item.types),
      );
      // Electron/Chromium exposes a PNG conversion for the native TIFF image.
      expect(formats).toContain("image/png");
      const image = await window.evaluate(async () =>
        (
          globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi }
        ).orkestrator.clipboard.readImage(),
      );
      expect(image).toMatchObject({ width: 3, height: 2 });
      expect(image?.dataUrl).toMatch(/^data:image\/png;base64,/);
    }
    const electronPid = await app.evaluate(() => process.pid);
    expect(electronPid).toBeTruthy();
    const backendPid = await expect
      .poll(() => backendChildPid(electronPid!), { timeout: 10_000 })
      .not.toBeNull()
      .then(() => backendChildPid(electronPid!));
    expect(backendPid).not.toBeNull();

    if (failure && failure !== "renderer") {
      // Stub only native user decisions and relaunch side effects. The real
      // supervisor, main-process callback, catalogue and marker recovery run.
      await app.evaluate(({ app, dialog }) => {
        const state = {
          prompts: [] as Electron.MessageBoxOptions[],
          relaunches: 0,
          quits: 0,
          answer: (_response: number) => {},
          restore: () => {},
        };
        const showMessageBox = dialog.showMessageBox;
        const relaunch = app.relaunch;
        const quit = app.quit;
        state.restore = () => {
          dialog.showMessageBox = showMessageBox;
          app.relaunch = relaunch;
          app.quit = quit;
        };
        // On macOS the dialog arrives with a parent window; it is the last argument.
        dialog.showMessageBox = ((...args: unknown[]) => {
          state.prompts.push(args.at(-1) as Electron.MessageBoxOptions);
          return new Promise<Electron.MessageBoxReturnValue>((resolve) => {
            state.answer = (response) => resolve({ response, checkboxChecked: false });
          });
        }) as typeof dialog.showMessageBox;
        app.relaunch = () => {
          state.relaunches += 1;
        };
        app.quit = () => {
          state.quits += 1;
        };
        (globalThis as any).__backendFailureTest = state;
      });
      const readState = () =>
        app.evaluate(() => {
          const { prompts, relaunches, quits } = (globalThis as any).__backendFailureTest;
          return { prompts, relaunches, quits };
        });
      if (failure === "planned") {
        // Real before-quit wiring calls BackendProcess.stop(), which must not
        // enter the unexpected-exit callback or offer Restart.
        await app.evaluate(({ app }) => {
          app.emit("before-quit", {} as Electron.Event);
        });
        await expect.poll(() => processExists(backendPid!), { timeout: 10_000 }).toBe(false);
        expect(await readState()).toEqual({ prompts: [], relaunches: 0, quits: 0 });
      } else {
        if (failure === "remote") {
          await writeRemoteRelaunchMarker(profile.dataDir, {
            jobId: "electron-recovery",
            version: "test",
          });
        }
        process.kill(backendPid!, "SIGKILL");
        if (failure === "remote") {
          await expect.poll(async () => (await readState()).quits).toBe(1);
          expect(await readState()).toEqual({ prompts: [], relaunches: 1, quits: 1 });
          expect(readRemoteRelaunchMarker(profile.dataDir)?.attempts).toBe(1);
        } else {
          await expect.poll(async () => (await readState()).prompts.length).toBe(1);
          expect((await readState()).prompts[0]).toMatchObject({
            buttons: ["Restart", "Close"],
            cancelId: 1,
          });
          // Both processes remain responsive while the dialog's promise is
          // unresolved: the Linux synchronous error-box regression froze here.
          expect(await window.evaluate(() => document.readyState)).toBe("complete");
          expect((await readState()).quits).toBe(0);
          await app.evaluate(
            (_electron, response) => {
              (globalThis as any).__backendFailureTest.answer(response);
            },
            failure === "restart" ? 0 : 1,
          );
          await expect
            .poll(async () => (await readState()).relaunches)
            .toBe(failure === "restart" ? 1 : 0);
          expect((await readState()).quits).toBe(failure === "restart" ? 1 : 0);
        }
        const catalogue = await window.evaluate(async () =>
          (
            globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi }
          ).orkestrator.connections.list(),
        );
        expect(catalogue.connections.find((entry) => entry.id === "local")?.transport).toBe(
          "unreachable",
        );
      }
      await app.evaluate(() => {
        (globalThis as any).__backendFailureTest.restore();
      });
      await app.close();
      launchedApp = null;
      return;
    }

    if (failure === "renderer") {
      const browserWindow = await app.browserWindow(window);
      const before = await browserWindow.evaluate((candidate) => ({
        id: candidate.id,
        rendererPid: candidate.webContents.getOSProcessId(),
      }));
      const recovered = await browserWindow.evaluate(
        (candidate) =>
          new Promise<{ reason: string; rendererPid: number }>((resolve) => {
            let reason = "";
            candidate.webContents.once(
              "render-process-gone",
              (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
                reason = details.reason;
              },
            );
            candidate.webContents.once("did-finish-load", () =>
              resolve({ reason, rendererPid: candidate.webContents.getOSProcessId() }),
            );
            process.kill(candidate.webContents.getOSProcessId(), "SIGKILL");
          }),
      );
      // Recovery must come from installRendererRecovery in the real main
      // process; the test never reloads the crashed page itself.
      expect(recovered.reason).toBe("killed");
      expect(recovered.rendererPid).toBeGreaterThan(0);
      expect(recovered.rendererPid).not.toBe(before.rendererPid);
      // Playwright keeps the old CDP Page marked as crashed. Observe the
      // replacement document through Electron's surviving WebContents.
      await expect
        .poll(
          () =>
            browserWindow.evaluate((candidate) =>
              candidate.webContents.executeJavaScript(
                `Boolean(document.querySelector('button[aria-label="Global settings"]')?.getClientRects().length)`,
              ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(await browserWindow.evaluate((candidate) => candidate.id)).toBe(before.id);
      expect(backendChildPid(electronPid!)).toBe(backendPid);
      expect(
        await browserWindow.evaluate((candidate) =>
          candidate.webContents.executeJavaScript(
            `window.orkestrator.invoke("greet", { name: "Recovered renderer" })`,
          ),
        ),
      ).toContain("Hello, Recovered renderer");
      await app.close();
      launchedApp = null;
      return;
    }

    // The sidebar's bottom bar, shown once the shell has loaded.
    const settingsControl = window.getByRole("button", { name: "Global settings" });
    await expect(settingsControl).toBeVisible();
    await window.bringToFront();
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.getTitle() ??
            null,
        ),
      )
      .toBe(`${profile.electronTitle} — Local`);
    if (!nicknamesOnly && !failure) {
      // View › Keyboard Shortcuts… reaches the focused window's renderer over
      // IPC. A click opens and never closes; a delivery of the menu's key
      // equivalent toggles. Every subsequent physical press toggles again.
      const clickKeyboardShortcuts = (triggeredByAccelerator: boolean) =>
        app.evaluate(({ BrowserWindow, Menu }, triggeredByAccelerator) => {
          const focusedWindow =
            BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
          const item = viewMenu?.submenu?.items.find(
            (candidate) => candidate.label === "Keyboard Shortcuts…",
          );
          if (!focusedWindow || !item?.click) {
            throw new Error("Keyboard Shortcuts… menu item is unavailable");
          }
          if (item.accelerator !== "CmdOrCtrl+Shift+/") {
            throw new Error(`Keyboard Shortcuts… shows ${String(item.accelerator)}`);
          }
          // Built MenuItem.click takes the event first; Electron forwards it
          // as the third argument to the template callback.
          item.click(
            {
              triggeredByAccelerator,
              shiftKey: triggeredByAccelerator,
              metaKey: triggeredByAccelerator && process.platform === "darwin",
              ctrlKey: triggeredByAccelerator && process.platform !== "darwin",
            },
            focusedWindow,
            focusedWindow.webContents,
          );
        }, triggeredByAccelerator);
      const shortcutsDialog = window.getByTestId("keyboard-shortcuts-dialog");
      const shortcutsSearch = window.getByRole("textbox", { name: "Search keyboard shortcuts" });

      await clickKeyboardShortcuts(false);
      await expect(shortcutsDialog).toBeVisible();
      await expect(shortcutsSearch).toBeFocused();
      await clickKeyboardShortcuts(false);
      await expect(shortcutsDialog).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(shortcutsDialog).toHaveCount(0);

      await clickKeyboardShortcuts(true);
      await expect(shortcutsDialog).toBeVisible();
      await clickKeyboardShortcuts(true);
      await expect(shortcutsDialog).toHaveCount(0);
      await clickKeyboardShortcuts(false);
      await expect(shortcutsDialog).toBeVisible();
      await window.keyboard.press(
        `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Slash`,
      );
      await expect(shortcutsDialog).toHaveCount(0);
      // Either modifier is accepted on every platform: on macOS, Control+Shift+/
      // as well as ⌘⇧/.
      await window.keyboard.press("Control+Shift+Slash");
      await expect(shortcutsDialog).toBeVisible();
      await window.keyboard.press("Control+Shift+Slash");
      await expect(shortcutsDialog).toHaveCount(0);

      // Electron's native input path must claim one press before either the
      // renderer page or the menu key equivalent can toggle a second time.
      await window.evaluate(() => {
        const state = { count: 0 };
        (globalThis as unknown as { shortcutPageInput: typeof state }).shortcutPageInput = state;
        globalThis.addEventListener(
          "keydown",
          (event) => {
            if (event instanceof KeyboardEvent && event.code === "Slash" && event.shiftKey)
              state.count++;
          },
          true,
        );
      });
      const nativeShortcut = (modifier: "meta" | "control") =>
        app.evaluate(({ BrowserWindow }, modifier) => {
          const host = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
          host.focus();
          host.webContents.focus();
          const modifiers: ("meta" | "control" | "shift")[] = [modifier, "shift"];
          host.webContents.sendInputEvent({ type: "keyDown", keyCode: "/", modifiers });
          host.webContents.sendInputEvent({ type: "keyUp", keyCode: "/", modifiers });
        }, modifier);
      for (const modifier of process.platform === "darwin"
        ? (["meta", "control"] as const)
        : (["control"] as const)) {
        await nativeShortcut(modifier);
        await expect(shortcutsDialog).toBeVisible();
        await nativeShortcut(modifier);
        await expect(shortcutsDialog).toHaveCount(0);
      }
      expect(
        await window.evaluate(
          () =>
            (globalThis as unknown as { shortcutPageInput: { count: number } }).shortcutPageInput
              .count,
        ),
      ).toBe(0);
    }
    const invokeNewWindowAccelerator = () =>
      app.evaluate(({ BrowserWindow, Menu }) => {
        const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const fileMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
        const newWindow = fileMenu?.submenu?.items.find((item) => item.label === "New Window");
        if (!focusedWindow || !newWindow?.click) {
          throw new Error("New Window menu item is unavailable");
        }
        newWindow.click(undefined, focusedWindow, focusedWindow.webContents);
      });
    const dispatchRendererCommandN = () =>
      window.evaluate(() => {
        const event = new KeyboardEvent("keydown", {
          key: "n",
          code: "KeyN",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        globalThis.dispatchEvent(event);
        return event.defaultPrevented;
      });
    const rendererTabCount = await window.locator('[aria-label^="Close "]').count();

    // Electron owns Command+N, but the DOM may observe the same keypress
    // before or after the native accelerator depending on the host. Exercise
    // the ActionBar listener on both sides of the real menu callback: neither
    // ordering may add a renderer tab or a duplicate BrowserWindow.
    expect(await dispatchRendererCommandN()).toBe(false);
    await invokeNewWindowAccelerator();
    expect(await dispatchRendererCommandN()).toBe(false);
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(2);
    await expect
      .poll(() => window.locator('[aria-label^="Close "]').count())
      .toBe(rendererTabCount);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect
      .poll(
        () => app.windows().filter((candidate) => candidate.url().startsWith(rendererUrl)).length,
        { timeout: 10_000 },
      )
      .toBe(2);
    const secondWindow = app
      .windows()
      .find((candidate) => candidate !== window && candidate.url().startsWith(rendererUrl));
    if (!secondWindow) throw new Error("New Window accelerator did not open a renderer window");
    await expect(secondWindow).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((candidate) => candidate.getTitle()),
        ),
      )
      .toEqual([`${profile.electronTitle} — Local`, `${profile.electronTitle} — Local`]);

    const readWindowMenu = () =>
      app.evaluate(({ Menu }) => {
        const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Window");
        const radios = (windowMenu?.submenu?.items ?? []).filter((item) => item.type === "radio");
        return {
          present: Boolean(windowMenu),
          labels: radios.map((item) => item.label),
          selected: radios.filter((item) => item.checked).map((item) => item.label),
        };
      });
    const windowMenu = await readWindowMenu();
    expect(windowMenu.present).toBe(true);
    // Two windows share one connection title, so the entries must be distinct.
    expect(windowMenu.labels).toEqual([
      `${profile.electronTitle} — Local (1)`,
      `${profile.electronTitle} — Local (2)`,
    ]);
    expect(windowMenu.selected).toHaveLength(1);

    if (nicknamesOnly) {
      // Treat this disposable backend as a remote through the production IPC path.
      // The token stays inside the renderer and is never returned or logged.
      const remoteAddress = `http://127.0.0.1:${gatewayPort}`;
      const remoteId = await window.evaluate(async (address) => {
        const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
          .orkestrator;
        const { token } = await api.webClient.getTokenSettings();
        return (await api.connections.connect({ address, token, nickname: "Desk" }))
          .activeConnectionId;
      }, remoteAddress);
      await secondWindow.evaluate(async (id) => {
        const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
          .orkestrator;
        await api.connections.use(id);
      }, remoteId);
      const readTitles = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((candidate) => candidate.getTitle()),
        );
      const assertRemoteLabels = async (nickname: string) => {
        await expect
          .poll(readTitles)
          .toEqual([
            `${profile.electronTitle} — ${nickname}`,
            `${profile.electronTitle} — ${nickname}`,
          ]);
        await expect
          .poll(async () => (await readWindowMenu()).labels)
          .toEqual([
            `${profile.electronTitle} — ${nickname} (1)`,
            `${profile.electronTitle} — ${nickname} (2)`,
          ]);
      };
      await assertRemoteLabels("Desk");
      await window.evaluate(async (id) => {
        const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
          .orkestrator;
        await api.connections.rename(id, "Studio");
      }, remoteId);
      await assertRemoteLabels("Studio");
      await window.evaluate(async (address) => {
        const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
          .orkestrator;
        const { token } = await api.webClient.getTokenSettings();
        await api.connections.connect({ address, token, nickname: "Workstation" });
      }, remoteAddress);
      await assertRemoteLabels("Workstation");
      // Reload the other renderer: its list must rehydrate the shared nickname.
      await secondWindow.reload();
      await expect
        .poll(() =>
          secondWindow.evaluate(async (id) => {
            const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
              .orkestrator;
            return (await api.connections.list()).connections.find((entry) => entry.id === id)
              ?.name;
          }, remoteId),
        )
        .toBe("Workstation");
      for (const page of [window, secondWindow]) {
        await page.evaluate(async () => {
          const api = (globalThis as typeof globalThis & { orkestrator: OrkestratorElectronApi })
            .orkestrator;
          await api.connections.use("local");
        });
      }
      await expect.poll(async () => (await readWindowMenu()).labels).toEqual(windowMenu.labels);

      await app.close();
      launchedApp = null;
      await expect.poll(() => processExists(backendPid!), { timeout: 10_000 }).toBe(false);
      return;
    }

    // Selecting the other entry must move focus to that window.
    const targetLabel = windowMenu.labels.find((label) => !windowMenu.selected.includes(label));
    if (!targetLabel) throw new Error("Window menu has no inactive entry to switch to");
    const targetPage = targetLabel.endsWith("(1)") ? window : secondWindow;
    const targetBrowserWindow = await app.browserWindow(targetPage);
    const targetWindowId = await targetBrowserWindow.evaluate((candidate) => candidate.id);
    await app.evaluate(({ BrowserWindow, Menu }, label) => {
      const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Window");
      const target = windowMenu?.submenu?.items.find(
        (item) => item.type === "radio" && item.label === label,
      );
      const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target?.click || !focusedWindow) {
        throw new Error("Window menu switch target is unavailable");
      }
      target.click(undefined, focusedWindow, focusedWindow.webContents);
    }, targetLabel);
    const hasKeyWindow = await app.evaluate(
      ({ app, BrowserWindow }) =>
        (process.platform !== "darwin" || app.isActive()) &&
        Boolean(BrowserWindow.getFocusedWindow()?.isFocused()),
    );
    if (process.platform === "linux" || (process.platform === "darwin" && !hasKeyWindow)) {
      // A shared macOS desktop can keep another app key, just as headless
      // Linux can expose no native focus. The selected menu label is still
      // mandatory; if this app owns a key window, switching must focus it.
      test.info().annotations.push({
        type: "skip-os-focus",
        description: `${process.platform}: no native focus available for the Window-menu assertion`,
      });
    } else {
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, expectedId) =>
              BrowserWindow.fromId(expectedId)?.isFocused() ?? false,
            targetWindowId,
          ),
        )
        .toBe(true);
    }
    await expect.poll(async () => (await readWindowMenu()).selected).toEqual([targetLabel]);

    await secondWindow
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
              isolatedViewState?: boolean;
            };
          }
        ).orkestrator;
        return {
          isolatedViewState: api.isolatedViewState,
          greeting: await api.invoke<string>("greet", { name: "Second window" }),
        };
      })
      .then((value) => {
        expect(value.isolatedViewState).toBe(true);
        expect(value.greeting).toContain("Hello, Second window");
      });
    expect(backendChildPid(electronPid!)).toBe(backendPid);

    await window.close();
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(1);
    // Closing the other window must remove its entry and drop the now-unneeded
    // numeric suffix, leaving the survivor as the sole selected radio.
    await expect
      .poll(async () => (await readWindowMenu()).labels)
      .toEqual([`${profile.electronTitle} — Local`]);
    await expect
      .poll(async () => (await readWindowMenu()).selected)
      .toEqual([`${profile.electronTitle} — Local`]);
    expect(backendChildPid(electronPid!)).toBe(backendPid);
    await secondWindow
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
            };
          }
        ).orkestrator;
        return api.invoke<string>("greet", { name: "Remaining window" });
      })
      .then((value) => expect(value).toContain("Hello, Remaining window"));

    await app.close();
    launchedApp = null;
    await expect.poll(() => processExists(backendPid!), { timeout: 10_000 }).toBe(false);
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("real Electron main process shares one backend across independent windows", async () => {
  await testIndependentWindows();
});

test("remote nicknames refresh all native titles and Window menu entries", async () => {
  await testIndependentWindows(true);
});

for (const scenario of ["close", "restart", "remote", "planned"] as const) {
  test(`real desktop backend exit wiring: ${scenario}`, async () => {
    await testIndependentWindows(false, scenario);
  });
}

test("real crashed renderer restores the window and reconnects to the existing backend", async () => {
  await testIndependentWindows(false, "renderer");
});

test("a real window with a missing preload reaches recovery without mounting the workspace", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "orkestrator-electron-preload-fault-"),
  );
  const entrypoint = path.join(temporaryRoot, "main.cjs");
  const [rendererPort] = await reserveLoopbackPorts(1);
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  let vite: ChildProcess | null = null;
  let launchedApp: ElectronApplication | null = null;
  try {
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
      },
    });
    ownProcessGroup(vite);
    recordProcessOutput("vite", vite);
    await waitForUrl(rendererUrl);
    await writeFile(
      entrypoint,
      [
        'const { app, BrowserWindow } = require("electron");',
        "app.whenReady().then(async () => {",
        "  const window = new BrowserWindow({",
        "    webPreferences: {",
        `      preload: ${JSON.stringify(path.join(temporaryRoot, "missing-preload.cjs"))},`,
        "      contextIsolation: true,",
        "      nodeIntegration: false,",
        "      sandbox: false,",
        "    },",
        "  });",
        `  await window.loadURL(${JSON.stringify(rendererUrl)});`,
        "});",
        'app.on("window-all-closed", () => app.quit());',
        "",
      ].join("\n"),
    );

    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [...ELECTRON_TEST_SWITCHES, entrypoint],
      cwd: repositoryRoot,
    });
    recordElectronDiagnostics(app);
    launchedApp = app;
    const window = await app.firstWindow();
    await expect(window.getByRole("alert")).toContainText("Orkestrator couldn’t connect", {
      timeout: 15_000,
    });
    await expect(window.getByRole("button", { name: "Reload window" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Global settings" })).toHaveCount(0);
    expect(await window.evaluate(() => typeof (globalThis as any).orkestrator)).toBe("undefined");
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("bootstrap window repaints a resized native Wayland surface at fractional scale", async () => {
  test.skip(
    process.platform !== "linux" || !process.env.WAYLAND_DISPLAY,
    "Native Wayland rendering requires a Linux Wayland display",
  );

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-wayland-smoke-"));
  const entrypoint = path.join(temporaryRoot, "main.cjs");
  const bootstrapDirname = path.join(packageRoot, "dist", "electron");
  const bootstrapModuleUrl = pathToFileURL(
    path.join(temporaryRoot, "toolchain-bootstrap-window.js"),
  ).href;
  let launchedApp: ElectronApplication | null = null;
  try {
    // The shipped bundle inlines this module, so bundle it on its own. Its
    // preload still resolves from the shared dist/electron output.
    const bundle = spawnSync(
      "bun",
      [
        "build",
        "electron/toolchain-bootstrap-window.ts",
        "--target=node",
        "--format=esm",
        "--external=electron",
        `--outdir=${temporaryRoot}`,
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(bundle.status, `${bundle.stdout}\n${bundle.stderr}`).toBe(0);
    await writeFile(
      entrypoint,
      [
        'const { app, BrowserWindow } = require("electron");',
        "app.whenReady().then(async () => {",
        `  const bootstrap = await import(${JSON.stringify(bootstrapModuleUrl)});`,
        "  await bootstrap.createToolchainBootstrapWindow({",
        "    BrowserWindowCtor: BrowserWindow,",
        `    dirname: ${JSON.stringify(bootstrapDirname)},`,
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        "--ozone-platform=wayland",
        "--force-device-scale-factor=1.25",
        entrypoint,
      ],
      cwd: repositoryRoot,
    });
    recordElectronDiagnostics(app);
    launchedApp = app;
    await app.firstWindow();

    const rendering = await captureBootstrapRendering(app);
    expectResponsiveBootstrapRendering(rendering);
    expect(rendering.ozonePlatform).toBe("wayland");
    expect(rendering.scaleFactor).toBeCloseTo(1.25, 2);
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
