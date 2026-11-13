import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile } from "../../apps/desktop/scripts/dev/profile-io";
import { listenEphemeral } from "@orkestrator/protocol/testing/ports";
import { closeElectronWithin } from "./design-electron-cleanup";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";

/**
 * A hidden agent-test profile on macOS answers every native dialog as
 * cancelled without opening UI, a host window or a sheet (to-do 2181 task 4,
 * step 4 of "Live macOS hidden-profile qualification" in
 * docs/development/agent-testing.md).
 *
 * The real desktop main process runs as an agent-test profile with
 * `ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS=1`, as `dev:test` starts it on a Mac
 * with no terminal. The spec then raises, first before any window exists and
 * then once the hidden main window is up: a synthetic main-process
 * `uncaughtException`, a windowless and a parented `dialog.showMessageBox`,
 * `dialog.showErrorBox`, and the renderer's own `confirm()`. Each must log a
 * `desktop.dialog` `hidden-cancelled` line naming its source and the cancel
 * response, never an `opening` line; no window may become visible or
 * focused, none may be added, and the app must stay a `UIElement` (no Dock
 * icon) that is never the front application.
 *
 * The remote-restart prompt (`confirmRestartWithCountdown`) cannot be reached
 * from a development profile, since host updates need a packaged build. It
 * goes through the same `nativeDialogs.showMessageBox` as the parented box
 * here; its `remote-restart` label is covered by
 * `apps/desktop/tests/native-dialogs.test.ts`.
 *
 * Markers in the dialog text are checked for in the output: dialogs must not
 * be logged with their text. The synthetic exception's own `desktop`
 * `uncaught-exception` line does carry its error, as documented, so its
 * marker is a separate one.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const DIALOG_TEXT_MARKER = "hidden-dialog-text-marker";
const EXCEPTION_MARKER = "hidden-dialog-synthetic-exception";

type WindowFacts = { count: number; visible: number; focused: number };
type MacAppFacts = { applicationType: string; front: boolean; onscreenWindows: number };

/** What the hidden profile's own windows are doing, from main. */
async function windowFacts(app: ElectronApplication): Promise<WindowFacts> {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    return {
      count: windows.length,
      visible: windows.filter((window) => window.isVisible()).length,
      focused: BrowserWindow.getFocusedWindow() ? 1 : 0,
    };
  });
}

/**
 * Runs one native probe and returns its output, failing the spec when the
 * probe did not answer: a failed or timed-out probe prints nothing, and
 * nothing would otherwise read as "no window" and "not front".
 */
function probe(command: string, args: string[], timeout: number): string {
  const run = spawnSync(command, args, { encoding: "utf8", timeout });
  if (run.error || run.signal || run.status !== 0)
    throw new Error(
      `${command} ${args[0]} did not answer (status ${run.status}, signal ${run.signal}): ${
        run.error?.message ?? run.stderr.trim()
      }`,
    );
  return run.stdout.trim();
}

/**
 * What macOS says about the process: its LaunchServices type (`UIElement`
 * for the `accessory` activation policy), whether it is the front
 * application, and how many of its windows the window server has on screen.
 * Window bounds and titles are not read. Every fact must be observed: a probe
 * that fails or answers in an unexpected shape fails the spec.
 */
function macAppFacts(pid: number): MacAppFacts {
  // `lsappinfo info` takes a pid or an ASN; its `-only` form prints no type.
  const info = probe("lsappinfo", ["info", String(pid)], 10_000);
  const applicationType = /\btype="([^"]+)"/.exec(info)?.[1];
  if (!applicationType) throw new Error(`lsappinfo reported no type for pid ${pid}`);
  const frontAsn = probe("lsappinfo", ["front"], 10_000);
  if (!/^ASN:\S+$/.test(frontAsn)) throw new Error("lsappinfo front named no application");
  const frontInfo = probe("lsappinfo", ["info", frontAsn], 10_000);
  const frontPid = /\bpid = (\d+)\b/.exec(frontInfo)?.[1];
  if (!frontPid) throw new Error("lsappinfo reported no pid for the front application");
  const onscreen = probe(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("CoreGraphics");
       const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
       let onscreen = 0;
       for (let i = 0; i < list.count; i++) {
         const window = list.objectAtIndex(i);
         if (ObjC.unwrap(window.objectForKey("kCGWindowOwnerPID")) === ${pid} &&
             ObjC.unwrap(window.objectForKey("kCGWindowIsOnscreen")) === true) onscreen += 1;
       }
       String(onscreen);`,
    ],
    20_000,
  );
  if (!/^\d+$/.test(onscreen)) throw new Error("the window server count was not a number");
  return {
    applicationType,
    front: Number(frontPid) === pid,
    onscreenWindows: Number(onscreen),
  };
}

/** The Electron binary's own pid: `.bin/electron` is a Node wrapper that spawns it. */
function electronAppPid(wrapper: number): number {
  const pids = probe("pgrep", ["-P", String(wrapper)], 10_000)
    .split("\n")
    .filter(Boolean)
    .map(Number);
  if (pids.length !== 1)
    throw new Error(`expected one Electron under the wrapper, found ${pids.length}`);
  return pids[0]!;
}

/**
 * Raises every dialog source main can raise, returning the responses it saw
 * and how many windows existed just before and just after.
 *
 * Everything between the two counts is synchronous: a hidden profile's router
 * decides and logs inside the call, so the phase is one uninterrupted run of
 * main's thread. A window startup creates cannot appear inside it, so
 * `windowsBefore` 0 proves the dialogs were raised with no window at all.
 */
async function raiseDialogs(app: ElectronApplication, parented: boolean) {
  return app.evaluate(
    async ({ BrowserWindow, dialog }, { parented, marker, exceptionMarker }) => {
      const live = () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      const options = {
        type: "question" as const,
        message: marker,
        detail: marker,
        buttons: ["OK", "Cancel"],
        cancelId: 1,
      };
      const windowsBefore = live().length;
      const parent = parented ? live()[0] : undefined;
      process.emit("uncaughtException", new Error(exceptionMarker), "uncaughtException");
      const windowless = dialog.showMessageBox(options);
      const withParent = parent ? dialog.showMessageBox(parent, options) : null;
      dialog.showErrorBox(marker, marker);
      const windowsAfter = live().length;
      return {
        windowsBefore,
        windowsAfter,
        windowless: (await windowless).response,
        withParent: withParent ? (await withParent).response : null,
      };
    },
    { parented, marker: DIALOG_TEXT_MARKER, exceptionMarker: EXCEPTION_MARKER },
  );
}

test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "hidden windows exist only on macOS");
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a hidden macOS profile cancels every native dialog without UI or focus", async () => {
  test.skip(process.platform !== "darwin", "hidden windows exist only on macOS");
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "orkestrator-electron-hidden-dialogs-"),
  );
  // The renderer is a one-line page on a server bound for the whole test, not
  // Vite: the dialogs need only a window with a page, and a page served from
  // here cannot lose its modules to host network churn (flake 2340). The
  // backend binds its own gateway port (`gatewayPort` 0).
  const pageServer = await listenEphemeral(createServer());
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-hidden-dialogs",
    flavor: "agent-test",
    rendererPort: pageServer.port,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  pageServer.server.on("request", (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${profile.electronTitle}</title>`);
  });
  const profilePath = await initializeProfile(profile);
  const rendererUrl = `http://127.0.0.1:${pageServer.port}`;
  let app: ElectronApplication | null = null;
  let output = "";
  try {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [...ELECTRON_TEST_SWITCHES, path.join(packageRoot, "dist", "electron", "main.js")],
      cwd: repositoryRoot,
      env: electronSpecEnvironment(process.env, {
        HOME: temporaryRoot,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1",
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      }),
    });
    const electronApp = app;
    recordElectronDiagnostics(electronApp);
    // Bounded: the spec needs the dialog lines, not the whole run.
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-512_000);
    };
    electronApp.process().stdout?.on("data", capture);
    electronApp.process().stderr?.on("data", capture);
    const pid = electronAppPid(electronApp.process().pid!);

    // Before main has created any window: no parent to find, no host to make.
    // Main creates its first window only after the local backend has started
    // (`startApplication` awaits `startLocal()`), seconds after launch, and
    // `raiseDialogs` checks there was none inside its own synchronous phase.
    const early = await raiseDialogs(electronApp, false);
    const afterEarly = await windowFacts(electronApp);

    const window = await electronApp.firstWindow();
    await expect.poll(() => window.title(), { timeout: 120_000 }).toBe(profile.electronTitle);
    const withWindow = await windowFacts(electronApp);
    const frontBefore = macAppFacts(pid);

    // A hidden parent, and the renderer's own box (Electron's `-run-dialog`).
    const late = await raiseDialogs(electronApp, true);
    const confirmed = await electronApp.evaluate(({ BrowserWindow }, marker) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return contents.executeJavaScript(`confirm(${JSON.stringify(marker)})`) as Promise<boolean>;
    }, DIALOG_TEXT_MARKER);
    await expect
      .poll(() => (output.match(/hidden-cancelled source=unrouted/g) ?? []).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(4);
    const afterLate = await windowFacts(electronApp);
    const frontAfter = macAppFacts(pid);

    const dialogLines = output
      .split("\n")
      .filter((line) => line.includes("[desktop.dialog]"))
      .map((line) => line.slice(line.indexOf("[desktop.dialog]")));
    await test.info().attach("hidden-dialogs", {
      body: JSON.stringify(
        {
          electron: await electronApp.evaluate(() => process.versions.electron),
          afterEarly,
          withWindow,
          afterLate,
          frontBefore,
          frontAfter,
          responses: { early, late, confirmed },
          dialogLines,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    expect(
      early.windowsBefore,
      "main created a window before the windowless phase ran; it must run before startup's first window",
    ).toBe(0);
    expect(early.windowsAfter).toBe(0);
    // Startup may have added its hidden main window since; none may show.
    expect(afterEarly).toMatchObject({ visible: 0, focused: 0 });
    expect(withWindow.visible).toBe(0);
    expect(afterLate).toEqual({ count: withWindow.count, visible: 0, focused: 0 });
    expect(early).toMatchObject({ windowless: 1, withParent: null });
    expect(late).toEqual({
      windowsBefore: withWindow.count,
      windowsAfter: withWindow.count,
      windowless: 1,
      withParent: 1,
    });
    expect(confirmed).toBe(false);
    for (const facts of [frontBefore, frontAfter]) {
      expect(facts.applicationType).toBe("UIElement");
      expect(facts.front).toBe(false);
      expect(facts.onscreenWindows).toBe(0);
    }
    const count = (line: string) => dialogLines.filter((entry) => entry === line).length;
    expect(count("[desktop.dialog] hidden-cancelled source=uncaught-exception response=0")).toBe(2);
    expect(count("[desktop.dialog] hidden-cancelled source=error-box response=0")).toBe(2);
    // Windowless and parented boxes from main, and the renderer's confirm().
    expect(count("[desktop.dialog] hidden-cancelled source=unrouted response=1")).toBe(4);
    expect(dialogLines.filter((line) => /\] (opening|closed|open-failed)\b/.test(line))).toEqual(
      [],
    );
    expect(output).not.toContain(DIALOG_TEXT_MARKER);
    expect(output).toContain(EXCEPTION_MARKER);
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    pageServer.server.closeAllConnections();
    await pageServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
