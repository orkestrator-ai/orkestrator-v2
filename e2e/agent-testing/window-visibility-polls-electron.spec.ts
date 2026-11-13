import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { expect, test } from "./electron-fixtures";
import { electronSpecEnvironment } from "./electron-spec-environment";

/**
 * Whether a real Electron window pauses the renderer's polls when it is
 * hidden, minimised or covered (part 0660 / WEB-18 of the renderer polling
 * work; to-do 5460 task 3, retired 2026-11-13, whose Linux run is to-do 2181
 * task 1's real-display run).
 *
 * The page runs the renderer's own `startCoordinatedPoll`, bundled from
 * `apps/web/src/lib/coordinated-poll.ts`, which pauses on
 * `document.visibilityState === "hidden"`. What a unit test cannot show is
 * whether the window's document reports `hidden` in each state, so this spec
 * puts a real window in each state and counts the poll's reads there.
 *
 * Electron is spawned directly, not through Playwright's `electron.launch()`:
 * attaching DevTools to a page (Playwright's focus emulation) counts as a
 * capture, which keeps a hidden window's document `visible` before the spec
 * has done anything. So the fixture's main process drives the steps itself
 * through `executeJavaScript` and prints one line per step for the spec to
 * check.
 *
 * Its window takes the desktop's `webPreferences` and Electron's default
 * background throttling, as `createMainWindow` does, and none of
 * `ELECTRON_TEST_SWITCHES`: their `--disable-backgrounding-occluded-windows`
 * and friends would switch off the very signal under test. It starts with
 * `show: false` and `paintWhenInitiallyHidden: false`, so the document
 * reports the window's real state from the first frame (Electron otherwise
 * keeps a never-shown window's page `visible`). On macOS the fixture takes the
 * `accessory` activation policy and windows that cannot take focus, so no case
 * moves the user's focus or adds a Dock icon.
 *
 * The three cases need different things from the host:
 *
 * - The never-shown window needs no display at all: Electron's
 *   `setBackgroundThrottling(false)`, which the hidden agent-test windows use
 *   (`apps/desktop/electron/hidden-windows.ts`), is the documented switch that
 *   makes Page Visibility report `visible`; turning it back on returns the
 *   hidden window to `hidden`. It runs everywhere.
 * - A window covered by the macOS lock screen shows a window, so like the
 *   desktop case it needs `ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1`, and it
 *   runs only while the session's screen is locked. A lock check before the
 *   run is not enough on its own: the fixture checks again before every step
 *   that shows a window, and hides its windows and stops the moment the screen
 *   unlocks, which skips the case.
 * - Hiding, minimising and covering a window that was on screen needs a
 *   display someone may see: a disposable one on Linux (the config's
 *   preflight), the Windows desktop, or a Mac whose person opted in with
 *   `ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1` on an unlocked screen
 *   (manual-test checklist 7568).
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const webLib = path.join(repositoryRoot, "apps", "web", "src", "lib");
const POLL_INTERVAL_MS = 400;
/** Five intervals; a hidden window must read in none of them. */
const MEASURE_MS = 2_000;
const SHOWN_WINDOWS_ENV = "ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS";
const STEP_LINE = "WINDOW_POLLS ";
/** The fixture's exit code when the screen it needs locked was unlocked. */
const UNLOCKED_EXIT_CODE = 3;
/**
 * POSIX runs own the fixture's process group (`ownProcessGroup`). Windows has
 * no process groups, and the group helpers need a `ps -o` that Git Bash does
 * not have, so there the child is tracked here and its tree is stopped with
 * `taskkill /T`, also from `afterEach` when a test times out.
 */
const PROCESS_GROUPS = process.platform !== "win32";
const windowsChildren = new Set<ChildProcess>();

type WindowAction =
  | "none"
  | "start-polls"
  | "show-inactive"
  | "hide"
  | "minimize"
  | "restore"
  | "cover"
  | "uncover"
  | "throttling-off"
  | "throttling-on";

/** One state change the fixture applies, then waits for and measures. */
type Step = {
  name: string;
  action: WindowAction;
  /** The document state the step waits for; `any` only records it. */
  expect: "hidden" | "visible" | "any";
  /** Count reads over `MEASURE_MS` once the state is reached. */
  measure?: boolean;
  /** Time from the state change to the poll's first read. */
  returnRead?: boolean;
};

type StepResult = {
  step: string;
  expected: Step["expect"];
  reached: boolean;
  visibility: string;
  windowVisible: boolean;
  minimized: boolean;
  coordinatorHidden: boolean;
  coordinatorPaused: boolean;
  reads: number | null;
  returnReadMs: number | null;
};

type RunResult = { steps: StepResult[]; hiddenReads: number; electron: string };

/** `CGSSessionScreenIsLocked` from the session's root registry entry. */
function macScreenLocked(): boolean {
  if (process.platform !== "darwin") return false;
  const run = spawnSync("ioreg", ["-n", "Root", "-d1"], { encoding: "utf8", timeout: 10_000 });
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(run.stdout ?? "");
}

/** Whether a window put on screen here lands only on a display meant for it. */
function shownWindowsAllowed(): { allowed: boolean; reason: string } {
  if (process.platform !== "darwin") return { allowed: true, reason: "" };
  if (process.env[SHOWN_WINDOWS_ENV] !== "1")
    return {
      allowed: false,
      reason: `macOS has no disposable display; set ${SHOWN_WINDOWS_ENV}=1 to show windows on this desktop`,
    };
  if (macScreenLocked())
    return { allowed: false, reason: "the screen is locked, so a shown window is always covered" };
  return { allowed: true, reason: "" };
}

const PAGE_ENTRY = `
import { startCoordinatedPoll } from ${JSON.stringify(path.join(webLib, "coordinated-poll.ts"))};
import { getReadCoordinator } from ${JSON.stringify(path.join(webLib, "read-coordinator.ts"))};
let reads = 0;
let hiddenReads = 0;
Object.assign(globalThis, {
  __polls: {
    start(intervalMs: number) {
      startCoordinatedPoll({
        resource: "window-visibility-spec",
        intervalMs,
        read: () => {
          reads += 1;
          if (document.visibilityState === "hidden") hiddenReads += 1;
        },
      });
    },
    state() {
      const diagnostics = getReadCoordinator().getDiagnostics();
      return {
        visibility: document.visibilityState,
        reads,
        hiddenReads,
        coordinatorHidden: diagnostics.hidden,
        coordinatorPaused: diagnostics.paused,
      };
    },
  },
});
`;

const FIXTURE_MAIN = `
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const page = process.env.WINDOW_POLLS_PAGE;
const requireLocked = process.env.WINDOW_POLLS_REQUIRE_LOCKED === "1";
const steps = JSON.parse(process.env.WINDOW_POLLS_STEPS);
const intervalMs = Number(process.env.WINDOW_POLLS_INTERVAL_MS);
const measureMs = Number(process.env.WINDOW_POLLS_MEASURE_MS);
// Never the active app, no Dock icon or menu bar.
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (line) => process.stdout.write(${JSON.stringify(STEP_LINE)} + JSON.stringify(line) + "\\n");
const screenLocked = () => {
  try {
    const registry = execFileSync("ioreg", ["-n", "Root", "-d1"], { encoding: "utf8", timeout: 10000 });
    return /"CGSSessionScreenIsLocked"\\s*=\\s*Yes/.test(registry);
  } catch {
    // Unknown counts as unlocked: never show a window on a guess.
    return false;
  }
};

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    focusable: process.platform !== "darwin",
    width: 320,
    height: 240,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let cover = null;
  // A case that may show windows only under the lock screen stops the moment
  // the screen unlocks, hiding its windows first so nobody sees them.
  const unlocked = () => {
    if (!window.isDestroyed()) window.hide();
    cover?.destroy();
    report({ unlocked: true });
    app.exit(${UNLOCKED_EXIT_CODE});
  };
  if (requireLocked) {
    const { powerMonitor } = require("electron");
    powerMonitor.on("unlock-screen", unlocked);
  }
  await window.loadFile(page);
  const state = () => window.webContents.executeJavaScript("__polls.state()");
  const reads = async () => (await state()).reads;
  const apply = async (action) => {
    switch (action) {
      case "none": return;
      case "start-polls": return window.webContents.executeJavaScript("__polls.start(" + intervalMs + ")");
      case "show-inactive": return window.showInactive();
      case "hide": return window.hide();
      case "minimize": return window.minimize();
      case "restore": return window.restore();
      case "throttling-off": return window.webContents.setBackgroundThrottling(false);
      case "throttling-on": return window.webContents.setBackgroundThrottling(true);
      case "cover": {
        const bounds = window.getBounds();
        cover = new BrowserWindow({
          x: bounds.x - 40, y: bounds.y - 40,
          width: bounds.width + 80, height: bounds.height + 80,
          show: false, frame: false, focusable: process.platform !== "darwin",
          backgroundColor: "#808080",
        });
        cover.setAlwaysOnTop(true, "floating");
        await cover.loadURL("about:blank");
        return cover.showInactive();
      }
      case "uncover":
        cover?.destroy();
        cover = null;
        return;
    }
  };
  for (const step of steps) {
    if (requireLocked && (step.action === "show-inactive" || step.action === "cover") && !screenLocked()) {
      unlocked();
      return;
    }
    const before = await reads();
    const changedAt = Date.now();
    await apply(step.action);
    let reached = step.expect === "any";
    for (let waited = 0; !reached && waited < 10000; waited += 50) {
      if ((await state()).visibility === step.expect) reached = true;
      else await sleep(50);
    }
    if (step.expect === "any") await sleep(1000);
    let returnReadMs = null;
    if (step.returnRead) {
      for (let waited = 0; waited < intervalMs + 3000; waited += 25) {
        if ((await reads()) > before) { returnReadMs = Date.now() - changedAt; break; }
        await sleep(25);
      }
    }
    const reached_ = await state();
    let measured = null;
    if (step.measure) {
      const start = await reads();
      await sleep(measureMs);
      measured = (await reads()) - start;
    }
    report({
      step: step.name,
      expected: step.expect,
      reached,
      visibility: reached_.visibility,
      windowVisible: window.isVisible(),
      minimized: window.isMinimized(),
      coordinatorHidden: reached_.coordinatorHidden,
      coordinatorPaused: reached_.coordinatorPaused,
      reads: measured,
      returnReadMs,
    });
  }
  report({ done: true, hiddenReads: (await state()).hiddenReads, electron: process.versions.electron });
  app.exit(0);
}).catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\\n");
  app.exit(1);
});
`;

let directory = "";

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "electron-window-polls-"));
  const entry = path.join(directory, "entry.ts");
  await writeFile(entry, PAGE_ENTRY);
  // Playwright loads specs under Node, so the page is bundled by a Bun child.
  // Each import resolves `@/` through apps/web's own tsconfig.
  const build = spawnSync(
    "bun",
    ["build", entry, "--target", "browser", "--outfile", path.join(directory, "page.js")],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
  );
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  await writeFile(
    path.join(directory, "page.html"),
    '<!doctype html><meta charset="utf-8"><title>window polls</title><script src="page.js"></script>',
  );
  await writeFile(path.join(directory, "main.cjs"), FIXTURE_MAIN);
});

test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});

test.afterEach(async () => {
  for (const child of Array.from(windowsChildren)) await stopFixture(child);
});

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Stops the fixture's Electron and everything it started. */
async function stopFixture(child: ChildProcess): Promise<void> {
  if (PROCESS_GROUPS) return stopProcessGroup(child);
  // An unreaped child still holds its pid, so the pid still names this child.
  if (!exited(child) && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 10_000,
      windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (exited(child)) {
        clearTimeout(timer);
        resolve();
      }
    });
    if (!exited(child)) throw new Error("The fixture's Electron did not exit");
  }
  windowsChildren.delete(child);
}

/**
 * Runs `steps` in a fresh Electron and returns what its main process reported.
 * With `requireLocked`, the fixture stops and the case skips if the screen is
 * or becomes unlocked.
 */
async function runSteps(
  name: string,
  steps: Step[],
  options: { requireLocked?: boolean } = {},
): Promise<RunResult> {
  const spawned = spawn(
    createRequire(import.meta.url)("electron") as string,
    [
      // Never the signed-in user's keychain.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      `--user-data-dir=${path.join(directory, `profile-${name}`)}`,
      path.join(directory, "main.cjs"),
    ],
    {
      detached: PROCESS_GROUPS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: electronSpecEnvironment(process.env, {
        ELECTRON_RUN_AS_NODE: undefined,
        WINDOW_POLLS_PAGE: path.join(directory, "page.html"),
        WINDOW_POLLS_STEPS: JSON.stringify(steps),
        WINDOW_POLLS_INTERVAL_MS: String(POLL_INTERVAL_MS),
        WINDOW_POLLS_MEASURE_MS: String(MEASURE_MS),
        WINDOW_POLLS_REQUIRE_LOCKED: options.requireLocked ? "1" : undefined,
      }),
    },
  );
  const child = PROCESS_GROUPS ? ownProcessGroup(spawned) : spawned;
  if (!PROCESS_GROUPS) windowsChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  // Bounded: only the tail is kept for the failure message.
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode));
    });
  } finally {
    await stopFixture(child);
  }
  test.skip(
    options.requireLocked === true && code === UNLOCKED_EXIT_CODE,
    "the screen unlocked during the run, so the fixture hid its windows and stopped",
  );
  expect(code, stderr).toBe(0);
  const lines = stdout
    .split("\n")
    .filter((line) => line.startsWith(STEP_LINE))
    .map((line) => JSON.parse(line.slice(STEP_LINE.length)) as Record<string, unknown>);
  const done = lines.find((line) => line.done === true);
  expect(done, stderr).toBeDefined();
  const result: RunResult = {
    steps: lines.filter((line) => line.done !== true) as unknown as StepResult[],
    hiddenReads: Number(done?.hiddenReads),
    electron: String(done?.electron),
  };
  await test.info().attach(name, {
    body: JSON.stringify(
      {
        platform: process.platform,
        intervalMs: POLL_INTERVAL_MS,
        measureMs: MEASURE_MS,
        ...result,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  return result;
}

function stepOf(result: RunResult, name: string): StepResult {
  const step = result.steps.find((entry) => entry.step === name);
  if (!step) throw new Error(`the fixture reported no step ${name}`);
  return step;
}

/** A hidden step reached `hidden` and the poll read nothing there. */
function expectPaused(step: StepResult): void {
  expect(step.reached, `${step.step}: ${JSON.stringify(step)}`).toBe(true);
  expect(step.visibility).toBe("hidden");
  expect(step.coordinatorPaused).toBe(true);
  if (step.reads !== null) expect(step.reads, step.step).toBe(0);
}

/** A visible step reached `visible`, read soon and kept reading. */
function expectPolling(step: StepResult): void {
  expect(step.reached, `${step.step}: ${JSON.stringify(step)}`).toBe(true);
  expect(step.visibility).toBe("visible");
  expect(step.coordinatorPaused).toBe(false);
  if (step.returnReadMs !== undefined && step.returnReadMs !== null)
    expect(step.returnReadMs).toBeLessThan(POLL_INTERVAL_MS + 3_000);
  if (step.reads !== null) expect(step.reads, step.step).toBeGreaterThanOrEqual(2);
}

test("a hidden window's polls read only while Electron reports it visible", async () => {
  test.setTimeout(90_000);
  const result = await runSteps("hidden-window-polls", [
    { name: "initial", action: "none", expect: "hidden" },
    { name: "hidden", action: "start-polls", expect: "hidden", measure: true },
    {
      name: "throttling off",
      action: "throttling-off",
      expect: "visible",
      returnRead: true,
      measure: true,
    },
    { name: "throttling on", action: "throttling-on", expect: "hidden", measure: true },
  ]);
  expectPaused(stepOf(result, "initial"));
  expectPaused(stepOf(result, "hidden"));
  const visible = stepOf(result, "throttling off");
  expectPolling(visible);
  expect(visible.returnReadMs).not.toBeNull();
  expectPaused(stepOf(result, "throttling on"));
  expect(stepOf(result, "throttling on").windowVisible).toBe(false);
  expect(result.hiddenReads).toBe(0);
});

test("a window the macOS lock screen covers pauses its polls", async () => {
  test.skip(process.platform !== "darwin", "the lock screen case is macOS only");
  // It shows a window, so it needs the same opt-in as the desktop case: a
  // lock check is not permission to show one.
  test.skip(
    process.env[SHOWN_WINDOWS_ENV] !== "1",
    `the case shows a window; set ${SHOWN_WINDOWS_ENV}=1 and lock the screen to run it`,
  );
  test.skip(!macScreenLocked(), "the session's screen is not locked");
  test.setTimeout(90_000);
  const result = await runSteps(
    "lock-screen-covered-polls",
    [
      { name: "start", action: "start-polls", expect: "hidden" },
      // Electron marks a shown window visible; macOS then reports it occluded.
      {
        name: "shown under the lock screen",
        action: "show-inactive",
        expect: "hidden",
        measure: true,
      },
      // The poll is alive: Electron's switch makes the page visible and it reads.
      { name: "throttling off", action: "throttling-off", expect: "visible", returnRead: true },
      { name: "throttling on", action: "throttling-on", expect: "hidden", measure: true },
    ],
    { requireLocked: true },
  );
  const covered = stepOf(result, "shown under the lock screen");
  expectPaused(covered);
  expect(covered.windowVisible).toBe(true);
  const visible = stepOf(result, "throttling off");
  expectPolling(visible);
  expect(visible.returnReadMs).not.toBeNull();
  expectPaused(stepOf(result, "throttling on"));
  expect(result.hiddenReads).toBe(0);
});

test("hidden, minimised and covered windows on a desktop pause their polls", async () => {
  const shown = shownWindowsAllowed();
  test.skip(!shown.allowed, shown.reason);
  test.setTimeout(180_000);
  // Chromium tracks occlusion on macOS and Windows only, so a covered window
  // on Linux may stay visible: that is recorded, not asserted (the
  // manual-test checklist 7568's covered-window decision says what then).
  const coveredExpect = process.platform === "linux" ? "any" : "hidden";
  const result = await runSteps("desktop-window-polls", [
    { name: "start", action: "start-polls", expect: "hidden" },
    { name: "shown", action: "show-inactive", expect: "visible", measure: true },
    { name: "hidden", action: "hide", expect: "hidden", measure: true },
    { name: "shown again", action: "show-inactive", expect: "visible", returnRead: true },
    { name: "minimised", action: "minimize", expect: "hidden", measure: true },
    { name: "restored", action: "restore", expect: "visible", returnRead: true, measure: true },
    { name: "covered", action: "cover", expect: coveredExpect, measure: true },
    { name: "uncovered", action: "uncover", expect: "visible", measure: true },
  ]);
  expectPolling(stepOf(result, "shown"));
  expectPaused(stepOf(result, "hidden"));
  expectPolling(stepOf(result, "shown again"));
  expect(stepOf(result, "shown again").returnReadMs).not.toBeNull();
  // A bare Xvfb has no window manager, so nothing minimises the window there.
  const minimised = stepOf(result, "minimised");
  if (minimised.minimized || process.platform !== "linux") expectPaused(minimised);
  else
    test.info().annotations.push({
      type: "not-minimised",
      description: "the display has no window manager to minimise the window",
    });
  expectPolling(stepOf(result, "restored"));
  expect(stepOf(result, "restored").returnReadMs).not.toBeNull();
  if (coveredExpect === "hidden") expectPaused(stepOf(result, "covered"));
  expectPolling(stepOf(result, "uncovered"));
  expect(result.hiddenReads).toBe(0);
});
