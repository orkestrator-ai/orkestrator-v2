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
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import { focusedWebContentsUrls, trackWebContentsFocus } from "./webcontents-focus";

/**
 * A pull request link opens in the right-hand PR pane of the real desktop
 * window without touching the window itself (docs/architecture/github-pull-requests.md,
 * "Where an in-app pull request link opens"): the main process sees no
 * window focus change, no focus/show/raise call, no new window or view and no
 * external browser, and the main view keeps its project, tab and scroll.
 * Explicit "Open on GitHub" and a pull request the pane cannot load still
 * reach `shell.openExternal`, which is stubbed so no real browser opens.
 */

type Project = { id: string; name: string };
type NativeLog = {
  windowEvents: string[];
  calls: string[];
  created: string[];
  external: string[];
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const previewDir = path.join(repositoryRoot, "output", "visual-previews");
const SHOWN_PR = "https://github.com/acme/widget/pull/42";
const MISSING_PR = "https://github.com/acme/widget/pull/43";

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

/**
 * Records, in the main process, everything that could move the user's native
 * focus or leave the window: the host window's focus, blur, show, hide,
 * minimize and restore events; calls to raise or focus a window or the app;
 * new windows and views; and external-browser opens (answered without
 * launching a browser).
 */
async function installNativeRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app, BrowserWindow, shell }) => {
    const log: NativeLog = { windowEvents: [], calls: [], created: [], external: [] };
    (globalThis as typeof globalThis & { prPaneNative?: NativeLog }).prPaneNative = log;
    const host = BrowserWindow.getAllWindows()[0]!;
    for (const event of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) {
      host.on(event as "focus", () => log.windowEvents.push(event));
    }
    const prototype = BrowserWindow.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const name of ["focus", "show", "showInactive", "moveTop", "blur", "restore"]) {
      const original = prototype[name]!;
      prototype[name] = function (this: unknown, ...args: unknown[]) {
        log.calls.push(`window.${name}`);
        return original.apply(this, args);
      };
    }
    const appFocus = app.focus.bind(app);
    app.focus = (options?: { steal: boolean }) => {
      log.calls.push("app.focus");
      appFocus(options);
    };
    app.on("browser-window-created", () => log.created.push("window"));
    app.on("web-contents-created", (_event, contents) =>
      log.created.push(`contents:${contents.getType()}`),
    );
    shell.openExternal = async (url: string) => {
      log.external.push(url);
    };
  });
}

function nativeLog(app: ElectronApplication): Promise<NativeLog> {
  return app.evaluate(() => {
    const log = (globalThis as typeof globalThis & { prPaneNative?: NativeLog }).prPaneNative!;
    return {
      windowEvents: [...log.windowEvents],
      calls: [...log.calls],
      created: [...log.created],
      external: [...log.external],
    };
  });
}

function clearNativeLog(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    const log = (globalThis as typeof globalThis & { prPaneNative?: NativeLog }).prPaneNative!;
    for (const list of Object.values(log)) list.length = 0;
  });
}

/** Native window identity and focus, as the main process sees it. */
function nativeWindowState(app: ElectronApplication) {
  return app.evaluate(({ app, BrowserWindow, webContents }) => {
    const host = BrowserWindow.getAllWindows()[0]!;
    return {
      windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
      contentsCount: webContents.getAllWebContents().filter((contents) => !contents.isDestroyed())
        .length,
      bounds: host.getBounds(),
      visible: host.isVisible(),
      minimized: host.isMinimized(),
      focused: host.isFocused(),
      focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      appActive: process.platform !== "darwin" || app.isActive(),
    };
  });
}

/**
 * The PR viewer reads GitHub through the backend, which an isolated profile
 * cannot reach. Answer #42 with a fixture and fail #43 inside the renderer's
 * own store, so no request leaves the machine.
 */
async function seedPullRequests(window: Page): Promise<void> {
  await window.evaluate(async () => {
    // Vite serves the renderer's own modules, so these are the app's instances.
    const load = (url: string) => import(/* @vite-ignore */ url);
    const { usePullRequestsStore } = await load("/src/stores/pullRequestsStore.ts");
    const { getWindowScope } = await load("/src/lib/node-scope/app-window-scope.ts");
    const pullRequests = getWindowScope().commandScope().store(usePullRequestsStore.def);
    const { makeDetail } = await load(
      "/src/components/pull-requests/pull-request-test-fixtures.ts",
    );
    type Ref = { owner: string; repo: string; number: number };
    type PullRequestMaps = Record<
      "details" | "timelines" | "errors" | "loadedAt",
      Map<string, unknown>
    >;
    const key = (ref: Ref) => `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
    pullRequests.setState({
      loadDetail: async (ref: Ref) => {
        const id = key(ref);
        pullRequests.setState((state: PullRequestMaps) =>
          ref.number === 42
            ? {
                details: new Map(state.details).set(id, makeDetail({ ref })),
                loadedAt: new Map(state.loadedAt).set(`detail:${id}`, Date.now()),
              }
            : { errors: new Map(state.errors).set(`detail:${id}`, "Not Found") },
        );
      },
      loadTimeline: async (ref: Ref) => {
        const id = key(ref);
        pullRequests.setState((state: PullRequestMaps) => ({
          timelines: new Map(state.timelines).set(id, { ref, items: [], truncated: false }),
          loadedAt: new Map(state.loadedAt).set(`timeline:${id}`, Date.now()),
        }));
      },
      loadFiles: async () => undefined,
    });
  });
}

/** What the main view shows, from the renderer's own stores and DOM. */
function mainViewState(window: Page) {
  return window.evaluate(async () => {
    const { useUIStore } = await import(/* @vite-ignore */ "/src/stores/uiStore.ts" as string);
    const { getWindowScope } = await import(
      /* @vite-ignore */ "/src/lib/node-scope/app-window-scope.ts" as string
    );
    const ui = getWindowScope().commandScope().store(useUIStore.def).getState();
    const board = document.querySelector("#project-panel-kanban");
    const scroll = board
      ? [board, ...board.querySelectorAll("*")]
          .filter((node) => node.scrollHeight > node.clientHeight)
          .map((node) => node.scrollTop)
      : null;
    return {
      marker: (globalThis as unknown as { __prPaneQa?: number }).__prPaneQa ?? null,
      url: location.href,
      selectedProjectId: ui.selectedProjectId,
      selectedEnvironmentId: ui.selectedEnvironmentId,
      projectBoardTab: ui.projectBoardTab,
      kanbanSelected:
        Array.from(document.querySelectorAll('[role="tab"]'))
          .find((tab) => tab.textContent?.trim() === "Kanban")
          ?.getAttribute("aria-selected") ?? null,
      scroll,
    };
  });
}

/** Activates the focused element with a native Enter key, sent by the main process. */
async function pressNativeEnter(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0]!.webContents;
    host.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    host.sendInputEvent({ type: "char", keyCode: "\r" });
    host.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  });
}

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a pull request link opens the PR pane without moving native window focus", async () => {
  test.setTimeout(240_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-pr-pane-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-pr-pane",
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
  const projectPath = await prepareFixtureRepository(
    profile,
    path.join(repositoryRoot, "test-fixtures", "agent-project"),
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
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        path.join(repositoryRoot, "apps", "desktop", "dist", "electron", "main.js"),
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      },
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    dismissStartupDialogs(electronApp);
    const window = await electronApp.firstWindow();
    window.setDefaultTimeout(20_000);
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await trackWebContentsFocus(electronApp);
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      window.evaluate(
        ({ command, args }) =>
          (
            globalThis as typeof globalThis & {
              orkestrator: {
                invoke<R>(command: string, args?: Record<string, unknown>): Promise<R>;
              };
            }
          ).orkestrator.invoke<T>(command, args),
        { command, args },
      );

    const project = await invoke<Project>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const title = "PR pane native focus";
    await invoke("add_kanban_task", {
      projectId: project.id,
      title,
      description: `[Review PR](${SHOWN_PR})\n\n[Missing PR](${MISSING_PR})`,
    });
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 900),
    );
    await seedPullRequests(window);

    // Give the window OS focus where the desktop session allows it. A shared
    // macOS desktop can keep another app key (todo 1170); the main-process
    // record below holds on every host, and the OS focus is checked when the
    // session did activate this window.
    const nativeKey = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
      if (process.platform === "darwin") app.focus({ steal: true });
      const host = BrowserWindow.getAllWindows()[0]!;
      host.show();
      host.focus();
      host.webContents.focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return host.isFocused();
    });
    if (!nativeKey)
      test.info().annotations.push({
        type: "native-focus",
        description:
          "The desktop session did not activate Electron. The main process's focus and blur events, raise calls, windows and views are checked; OS key-window focus is not.",
      });
    const focusedViews = () => focusedWebContentsUrls(electronApp);
    await expect.poll(focusedViews).toEqual([window.url()]);

    await window
      .getByRole("button", { name: new RegExp(`^${project.name}`) })
      .first()
      .click();
    await window.getByRole("tab", { name: "Kanban", exact: true }).click();
    const closePanel = window.getByRole("button", { name: "Close panel", exact: true });
    if (await closePanel.isVisible()) await closePanel.click();
    const card = window.getByText(title, { exact: true }).first();
    await card.click();
    const dialog = window.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // A reload of the window would drop this marker.
    await window.evaluate(() => {
      (globalThis as unknown as { __prPaneQa?: number }).__prPaneQa = 1;
    });
    const view = await mainViewState(window);
    expect(view).toMatchObject({
      marker: 1,
      selectedProjectId: project.id,
      kanbanSelected: "true",
    });
    const native = await nativeWindowState(electronApp);
    // Where the OS made the window key, the comparisons below require it to
    // stay the key window of the active app.
    if (nativeKey) expect(native).toMatchObject({ focused: true, appActive: true });
    const focusedBefore = await focusedViews();
    await installNativeRecorder(electronApp);

    // Open from the link with a native key press, as a keyboard user would.
    await dialog.getByRole("link", { name: "Review PR", exact: true }).focus();
    await pressNativeEnter(electronApp);
    await expect(dialog).toHaveCount(0);
    await expect(closePanel).toBeVisible();
    await expect(window.getByText("feat: add usage history tab").first()).toBeVisible();
    await window.screenshot({ path: path.join(previewDir, "pr-pane-electron-open.png") });

    const expectWindowUntouched = async () => {
      expect(await mainViewState(window)).toEqual(view);
      expect(await nativeWindowState(electronApp)).toEqual(native);
      expect(await focusedViews()).toEqual(focusedBefore);
      expect(await nativeLog(electronApp)).toEqual({
        windowEvents: [],
        calls: [],
        created: [],
        external: [],
      });
    };
    await expectWindowUntouched();

    await closePanel.click();
    await expect(closePanel).toHaveCount(0);
    await expectWindowUntouched();
    await window.screenshot({ path: path.join(previewDir, "pr-pane-electron-closed.png") });

    // An explicit "Open on GitHub" still goes to the external browser.
    await card.click();
    await dialog.getByRole("link", { name: "Review PR", exact: true }).click();
    await expect(closePanel).toBeVisible();
    await window.getByTitle("Open on GitHub", { exact: true }).first().click();
    await expect.poll(async () => (await nativeLog(electronApp)).external).toEqual([SHOWN_PR]);
    await closePanel.click();
    await clearNativeLog(electronApp);

    // A pull request the pane cannot load falls back to the browser, once.
    await card.click();
    await dialog.getByRole("link", { name: "Missing PR", exact: true }).click();
    await expect.poll(async () => (await nativeLog(electronApp)).external).toEqual([MISSING_PR]);
    const fallback = await nativeLog(electronApp);
    expect(fallback.created).toEqual([]);
    expect(fallback.calls).toEqual([]);
    expect((await mainViewState(window)).kanbanSelected).toBe("true");
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
