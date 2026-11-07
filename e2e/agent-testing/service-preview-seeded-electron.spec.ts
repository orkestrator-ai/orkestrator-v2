/**
 * Seeded entry-port preview services in the actual Electron window, with the
 * desktop tunnel enabled (docs/todo/previews-and-annotations/0045-preview-service-discovery.md,
 * task 1).
 *
 * Launches Electron with a disposable agent-test profile under a temporary
 * root (never the user's profile or backend data). The fixture project gets
 * an `entryPort` in its repository config and a `run` command that starts a
 * development server which, like Vite, moves to the next port when its own is
 * taken. Two local environments are created from it, so each is seeded an
 * `app` service on the same entry port. Then, through the real window:
 *
 * 1. the environment browser button opens the seeded service, which waits for
 *    this environment's server until **Run** starts it and then loads it
 *    without a Retry;
 * 2. with both servers running each environment opens only its own, and the
 *    second's terminal link (⌘⇧-click) offers to move its service to the port
 *    its server took;
 * 3. after a restart, a request from the open tab (never reloaded) reaches
 *    the new process, and the old endpoint generation is refused;
 * 4. ⌘⇧-click on a loopback link in an agent's reply opens a preview tab in
 *    that environment, and a plain click opens the system browser (captured,
 *    never launched);
 * 5. route details → Framework setup hints shows the private origin when
 *    publication is on, and Copy puts the snippet on the clipboard.
 *
 * The agent reply in check 4 is the real `MessageMarkdown` rendered inside
 * the link-source context an environment's agent tab provides, not a live
 * agent turn: a seeded transcript would need a billed provider run.
 */
import type { Page, TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isEnvironmentSetupSettled } from "@orkestrator/protocol/environment-readiness";
import type { PreviewServiceSnapshot } from "@orkestrator/protocol/preview-services";

import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { certificates, TEST_PREVIEW_DOMAIN } from "../../apps/backend/src/preview-test-pki";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { recordProcessOutput, withElectronDiagnostics } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import {
  alive,
  bundleElectron,
  closeElectron,
  launchElectron,
  repositoryRoot,
  waitForUrl,
  webRoot,
} from "./service-preview-electron-launch";

const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");
const devServerScript = path.join(import.meta.dirname, "seeded-entry-dev-server.ts");

type Name = "a" | "b";

interface SeededEnvironment {
  id: string;
  worktreePath: string;
  /** The Run Commands terminal tab, once Run has been pressed. */
  runTabId?: string;
  /** The tab the environment browser button opened. */
  serviceTabId?: string;
}

interface Stack {
  temporaryRoot: string;
  profile: RuntimeProfile;
  profilePath: string;
  rendererUrl: string;
  vite: ChildProcess;
  app: ElectronApplication;
  window: Page;
  windowId: number;
  projectId: string;
  entryPort: number;
  /** The fixture project's `run` command (also typed to restart a server). */
  runCommand: string;
  environments: Partial<Record<Name, SeededEnvironment>>;
  /** Dev server processes the checks started, for an identity-checked stop. */
  devServerPids: Set<number>;
}

let stack: Stack | null = null;

function s(): Stack {
  if (!stack) throw new Error("Seeded preview stack is not running");
  return stack;
}

function env(name: Name): SeededEnvironment {
  const environment = s().environments[name];
  if (!environment) throw new Error(`Environment ${name} is not created`);
  return environment;
}

function record(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
  s().window.evaluate(
    ({ command, args }) => (globalThis as any).orkestrator.invoke(command, args),
    { command, args },
  ) as Promise<T>;

/** Two adjacent free loopback ports: the entry port and the one a moved server takes. */
async function freePortPair(): Promise<number> {
  const bindable = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [port] = (await reserveLoopbackPorts(1)) as [number];
    if (port < 65_000 && (await bindable(port + 1))) return port;
  }
  throw new Error("No two adjacent free loopback ports");
}

function bunExecutable(): string {
  const found = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" });
  const bun = found.stdout.trim();
  if (found.status !== 0 || !bun) throw new Error("bun is not on PATH");
  return bun;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
}

/** Run a renderer store action through the app's own module instance. */
async function store<T>(modulePath: string, script: string, arg: unknown = null): Promise<T> {
  return s().window.evaluate(
    async ({ modulePath, script, arg }) => {
      const module = await import(modulePath);
      // A per-node store's instance in the app's command scope.
      const { getWindowScope } = await import(
        /* @vite-ignore */ "/src/lib/node-scope/app-window-scope.ts" as string
      );
      const commandStore = (hook: { def: unknown }) =>
        getWindowScope().commandScope().store(hook.def);
      return new Function("module", "arg", "commandStore", script)(module, arg, commandStore);
    },
    { modulePath, script, arg },
  ) as Promise<T>;
}

async function select(name: Name): Promise<void> {
  await store(
    "/src/stores/uiStore.ts",
    "commandStore(module.useUIStore).getState().selectProjectAndEnvironment(arg.projectId, arg.environmentId)",
    { projectId: s().projectId, environmentId: env(name).id },
  );
  await closeStartupDialogs();
}

/**
 * An open dialog correctly hides native previews; the startup-dialog handlers
 * run only before a locator action or assertion, so give them one.
 */
async function closeStartupDialogs(): Promise<void> {
  await expect(s().window.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
}

interface TabSummary {
  id: string;
  type: string;
  url: string | null;
  sessionId: string | null;
}

function tabs(name: Name): Promise<TabSummary[]> {
  return store(
    "/src/stores/paneLayoutStore.ts",
    `return commandStore(module.usePaneLayoutStore).getState().getAllTabs(arg).map((tab) => ({
      id: tab.id,
      type: tab.type,
      url: tab.browserData?.url ?? null,
      sessionId: tab.backendTerminalSessionId ?? null,
    }));`,
    env(name).id,
  );
}

function activeTabId(name: Name): Promise<string | null> {
  return store(
    "/src/stores/paneLayoutStore.ts",
    "return commandStore(module.usePaneLayoutStore).getState().getActivePane(arg)?.activeTabId ?? null",
    env(name).id,
  );
}

async function activateTab(name: Name, tabId: string): Promise<void> {
  await store(
    "/src/stores/paneLayoutStore.ts",
    `const state = commandStore(module.usePaneLayoutStore).getState();
     const pane = state.findPaneWithTab(arg.tabId, arg.environmentId);
     if (!pane) throw new Error("Tab is not in the layout");
     state.setActivePane(pane.id, arg.environmentId);
     state.setActiveTab(pane.id, arg.tabId, arg.environmentId);`,
    { environmentId: env(name).id, tabId },
  );
  await expect.poll(() => activeTabId(name)).toBe(tabId);
}

/** The id of the one tab of `type` that appears after `action`. */
async function newTab(name: Name, type: string, action: () => Promise<void>): Promise<string> {
  const before = new Set((await tabs(name)).map((tab) => tab.id));
  await action();
  let created: string | null = null;
  await expect
    .poll(
      async () => {
        const added = (await tabs(name)).filter((tab) => !before.has(tab.id) && tab.type === type);
        created = added.length === 1 ? added[0]!.id : null;
        return added.length;
      },
      { timeout: 30_000, message: `a new ${type} tab in environment ${name}` },
    )
    .toBe(1);
  return created!;
}

async function services(name: Name): Promise<PreviewServiceSnapshot[]> {
  const snapshot = await invoke<{ services: PreviewServiceSnapshot[] }>("get_preview_services", {
    environmentId: env(name).id,
  });
  return snapshot.services;
}

/** The environment's seeded `app` service (key `entry:<port>`). */
async function seeded(name: Name): Promise<PreviewServiceSnapshot> {
  const found = (await services(name)).filter(
    (service) => service.definition.label === "app" && service.definition.entry,
  );
  if (found.length !== 1) throw new Error(`Expected one seeded service, found ${found.length}`);
  return found[0]!;
}

/** Visible preview views in the main window, with the dev server marker each shows. */
function visiblePreviews(): Promise<
  Array<{ url: string; marker: string | null; documentId: string | null }>
> {
  return s().app.evaluate(
    async ({ BrowserWindow }, { windowId, rendererUrl }) => {
      const host = BrowserWindow.fromId(windowId);
      const out: Array<{ url: string; marker: string | null; documentId: string | null }> = [];
      for (const child of host?.contentView.children ?? []) {
        const view = child as unknown as {
          getVisible(): boolean;
          webContents?: {
            isDestroyed(): boolean;
            getURL(): string;
            executeJavaScript(script: string, gesture?: boolean): Promise<unknown>;
          };
        };
        const contents = view.webContents;
        if (!contents || contents.isDestroyed() || !view.getVisible()) continue;
        const url = contents.getURL();
        if (!url || url.startsWith(rendererUrl)) continue;
        const marker = await contents
          .executeJavaScript('document.querySelector("h1")?.textContent ?? null', true)
          .catch(() => null);
        const documentId = await contents.executeJavaScript(
          "document.body?.dataset.documentId ?? null",
        );
        out.push({
          url,
          marker: typeof marker === "string" ? marker : null,
          documentId: typeof documentId === "string" ? documentId : null,
        });
      }
      return out;
    },
    { windowId: s().windowId, rendererUrl: s().rendererUrl },
  );
}

/** The marker pattern of an environment's dev server: worktree and process. */
function markerOf(name: Name): RegExp {
  const worktree = path.basename(env(name).worktreePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^seeded-${worktree}-(\\d+)$`);
}

/**
 * Wait until the one visible preview shows a marker matching `pattern`, other
 * than `previous` when given; returns it.
 */
async function expectShown(
  pattern: RegExp,
  { previous, timeout = 60_000 }: { previous?: string; timeout?: number } = {},
): Promise<string> {
  let last: unknown = null;
  let shown = "";
  await expect
    .poll(
      async () => {
        await closeStartupDialogs().catch(() => undefined);
        const views = await visiblePreviews();
        last = views;
        const match = views.length === 1 ? views[0]!.marker : null;
        shown = match ?? "";
        return match !== null && match !== previous && pattern.test(match);
      },
      { timeout, message: `a visible preview showing ${pattern}` },
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`${error.message}\n${JSON.stringify(last)}`);
    });
  const pid = Number(pattern.exec(shown)?.[1]);
  if (Number.isInteger(pid)) s().devServerPids.add(pid);
  return shown;
}

/**
 * Which dev server process answers a request made from inside the one
 * visible preview page, as an application's own client (HMR, polling) would.
 */
function pageRequestMarker(): Promise<string | { error: string }> {
  return s().app.evaluate(
    async ({ BrowserWindow }, { windowId, rendererUrl }) => {
      const host = BrowserWindow.fromId(windowId);
      for (const child of host?.contentView.children ?? []) {
        const view = child as unknown as {
          getVisible(): boolean;
          webContents?: {
            isDestroyed(): boolean;
            getURL(): string;
            executeJavaScript(script: string, gesture?: boolean): Promise<unknown>;
          };
        };
        const contents = view.webContents;
        if (!contents || contents.isDestroyed() || !view.getVisible()) continue;
        if (contents.getURL().startsWith(rendererUrl)) continue;
        return contents
          .executeJavaScript(
            `fetch("/health", { cache: "no-store" }).then((response) => response.ok ? response.json().then((body) => body.marker) : { error: "HTTP " + response.status })`,
            true,
          )
          .catch((error: Error) => ({ error: error.message.slice(0, 200) })) as Promise<
          string | { error: string }
        >;
      }
      return { error: "no visible preview" };
    },
    { windowId: s().windowId, rendererUrl: s().rendererUrl },
  );
}

function pidOf(marker: string): number {
  const pid = Number(/-(\d+)$/.exec(marker)?.[1]);
  if (!Number.isInteger(pid)) throw new Error(`No pid in ${marker}`);
  return pid;
}

/** Press Run in the selected environment and return the Run Commands tab. */
async function pressRun(name: Name): Promise<string> {
  const run = s().window.getByRole("button", { name: "Run commands" });
  await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 60_000 });
  const tabId = await newTab(name, "plain", () => run.click());
  env(name).runTabId = tabId;
  await expect.poll(() => activeTabId(name)).toBe(tabId);
  return tabId;
}

/** Press the environment browser button and return the tab it opens. */
async function pressBrowser(name: Name): Promise<string> {
  const button = s().window.getByRole("button", { name: "New browser tab" });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  const tabId = await newTab(name, "browser", () => button.click());
  env(name).serviceTabId = tabId;
  return tabId;
}

/**
 * Where a URL printed in a terminal tab is on screen. Marks that terminal's
 * screen element so a locator can click it with modifiers.
 */
async function terminalLinkPoint(
  name: Name,
  tabId: string,
  url: string,
): Promise<{ x: number; y: number } | string> {
  return store(
    "/src/stores/terminalPortalStore.ts",
    `const data = module.useTerminalPortalStore.getState().getTerminal(module.commandTerminalPortalNodeId(), arg.environmentId, arg.tabId);
     if (!data) return "no terminal";
     const screen =
       data.terminal.element?.querySelector(".xterm-screen") ??
       data.portalElement?.querySelector(".xterm-screen") ??
       data.containerElement?.querySelector(".xterm-screen");
     if (!screen) return "no screen (opened: " + data.isOpened + ", element: " + Boolean(data.terminal.element) + ")";
     const terminal = data.terminal;
     const buffer = terminal.buffer.active;
     for (let row = 0; row < terminal.rows; row += 1) {
       const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "";
       const column = line.indexOf(arg.url);
       if (column < 0) continue;
       document.querySelectorAll("[data-seeded-link-screen]").forEach((element) =>
         element.removeAttribute("data-seeded-link-screen"));
       screen.setAttribute("data-seeded-link-screen", "");
       const rect = screen.getBoundingClientRect();
       const width = rect.width / terminal.cols;
       const height = rect.height / terminal.rows;
       return { x: (column + 4) * width, y: (row + 0.5) * height };
     }
     // Positions only: terminal contents never go into a test report.
     return "not printed yet";`,
    { environmentId: env(name).id, tabId, url },
  );
}

/** Stop a dev server this spec started, after checking the pid still names it. */
function stopDevServer(pid: number): void {
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (command.status !== 0 || !command.stdout.includes("seeded-entry-dev-server.ts")) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

async function waitForEnvironmentReady(environmentId: string): Promise<string> {
  let worktreePath = "";
  await expect
    .poll(
      async () => {
        const environment = await invoke<{
          status?: string;
          worktreePath?: string;
          setupPhase?: string;
          setupScriptsComplete?: boolean;
          setupOverride?: boolean;
        } | null>("get_environment", { environmentId });
        worktreePath = environment?.worktreePath ?? "";
        return (
          environment?.status === "running" &&
          Boolean(worktreePath) &&
          isEnvironmentSetupSettled(environment as never)
        );
      },
      { timeout: 120_000, message: `environment ${environmentId} running with setup done` },
    )
    .toBe(true);
  return worktreePath;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.info().setTimeout(360_000);
  bundleElectron();

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-seeded-preview-"));
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "service-preview-seeded",
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
  const vite = spawn("bun", ["run", "dev"], {
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
  const entryPort = await freePortPair();
  const runCommand = `SEEDED_ENTRY_PORT=${entryPort} '${bunExecutable()}' '${devServerScript}'`;
  const partial = {
    temporaryRoot,
    profile,
    profilePath,
    rendererUrl,
    vite,
    entryPort,
    runCommand,
    environments: {},
    devServerPids: new Set<number>(),
  } as unknown as Stack;
  stack = partial;
  await waitForUrl(rendererUrl);
  const { app, window, windowId } = await withElectronDiagnostics(() => launchElectron(partial));
  partial.app = app;
  partial.window = window;
  partial.windowId = windowId;

  // The dev-test fixture project, with a `run` command for the Run button.
  const projectPath = await prepareFixtureRepository(profile, templateRoot);
  await writeFile(
    path.join(projectPath, "orkestrator-ai.json"),
    `${JSON.stringify({ run: [runCommand] }, null, 2)}\n`,
  );
  runGit(projectPath, ["add", "orkestrator-ai.json"]);
  runGit(projectPath, ["commit", "-m", "Run the seeded entry dev server"]);
  runGit(projectPath, ["push", "origin", "main"]);
  const project = await invoke<{ id: string }>("add_project", {
    gitUrl: path.join(profile.fixtureDir, "origin.git"),
    localPath: projectPath,
  });
  partial.projectId = project.id;
  // The repository config's entry port, copied onto each new environment.
  await invoke("patch_repository_settings", {
    projectId: project.id,
    updates: { entryPort },
  });
  for (const name of ["a", "b"] as const) {
    const environment = await invoke<{ id: string }>("create_environment", {
      projectId: project.id,
      name: `seeded-${name}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: environment.id });
    partial.environments[name] = {
      id: environment.id,
      worktreePath: await waitForEnvironmentReady(environment.id),
    };
  }
});

test.afterAll(async () => {
  test.info().setTimeout(90_000);
  const current = stack;
  if (!current) return;
  let running = false;
  try {
    const child = current.app?.process();
    running = Boolean(child) && child.exitCode === null && child.signalCode === null;
  } catch {
    // Playwright throws once the application has been closed.
  }
  if (running) await closeElectron(current.app).catch(() => undefined);
  stack = null;
  for (const pid of current.devServerPids) if (alive(pid)) stopDevServer(pid);
  if (current.vite) await stopProcessGroup(current.vite).catch(() => undefined);
  await rm(current.temporaryRoot, { recursive: true, force: true });
});

test("1. the browser button opens the seeded service, which waits for this environment's server and loads once Run starts it", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  const port = s().entryPort;
  for (const name of ["a", "b"] as const) {
    const service = await seeded(name);
    expect(service.definition).toMatchObject({
      targetKind: "worktree",
      applicationPort: port,
      entry: true,
    });
  }

  await select("a");
  await pressBrowser("a");
  await expect(
    s().window.getByText(`Waiting for this environment's server on port ${port}`),
  ).toBeVisible({ timeout: 60_000 });
  // Waiting is a refusal, never someone else's page: nothing is attached.
  expect(await visiblePreviews()).toEqual([]);

  await pressRun("a");
  // The registry's own recheck attributes the listener; nobody pressed Retry.
  await expect
    .poll(
      async () => {
        const { endpoint } = await seeded("a");
        return { state: endpoint.state, ownership: endpoint.ownership };
      },
      { timeout: 90_000, message: "the seeded service resolves to this environment's server" },
    )
    .toEqual({ state: "available", ownership: "managed-process" });

  await activateTab("a", env("a").serviceTabId!);
  const shown = await expectShown(markerOf("a"));
  record(testInfo, "a-server", shown);
  await expect(s().window.getByText(`Waiting for this environment's server`)).toHaveCount(0);
});

test("2. with both servers running each environment opens only its own, and a moved server is offered as a move", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  const port = s().entryPort;
  const moved = port + 1;

  await select("b");
  await pressBrowser("b");
  // Environment a's server holds the shared entry port; b refuses it.
  await expect(s().window.getByText(`Another environment's server is on port ${port}`)).toBeVisible(
    { timeout: 60_000 },
  );
  expect(await visiblePreviews()).toEqual([]);
  expect((await seeded("b")).endpoint.listener).toBe("other-environment");

  const runTab = await pressRun("b");
  const link = `http://127.0.0.1:${moved}/`;
  let point: { x: number; y: number } | null = null;
  let missing = "";
  await expect
    .poll(
      async () => {
        const found = await terminalLinkPoint("b", runTab, link);
        if (typeof found === "string") missing = found;
        else point = found;
        return point !== null;
      },
      { timeout: 60_000, message: `the dev server prints ${link}` },
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`${error.message}\n${missing}`);
    });
  const screen = s().window.locator("[data-seeded-link-screen]");
  await expect(async () => {
    await screen.hover({ position: point! });
    await expect(screen).toHaveClass(/xterm-cursor-pointer/, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const chooserTab = await newTab("b", "browser", () =>
    screen.click({ position: point!, modifiers: ["ControlOrMeta", "Shift"] }),
  );
  await expect.poll(() => activeTabId("b")).toBe(chooserTab);
  const move = s().window.getByRole("button", { name: `Move app from port ${port} to ${moved}` });
  await expect(move).toBeVisible({ timeout: 30_000 });
  await move.click();
  await expect
    .poll(async () => (await seeded("b")).definition.applicationPort, { timeout: 30_000 })
    .toBe(moved);
  const shownB = await expectShown(markerOf("b"));
  record(testInfo, "b-server", shownB);

  // Environment a still shows its own server on the entry port.
  await select("a");
  await activateTab("a", env("a").serviceTabId!);
  const shownA = await expectShown(markerOf("a"));
  expect(shownA).not.toBe(shownB);
  expect((await seeded("a")).definition.applicationPort).toBe(port);
});

test("3. a restarted dev server is reached from the open tab without a reload, and the old generation is refused", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  await select("a");
  await activateTab("a", env("a").serviceTabId!);
  const before = await expectShown(markerOf("a"));
  const documentId = (await visiblePreviews())[0]!.documentId;
  expect(documentId).toBeTruthy();
  const service = await seeded("a");
  const generation = service.endpoint.endpointGeneration;
  // A credential bound to the current generation, to show the old one is refused.
  const probe = await invoke<{ attachmentId: string; endpointGeneration: number }>(
    "create_preview_attachment",
    { serviceId: service.definition.serviceId, surface: "desktop-tunnel", clientKey: "seeded" },
  );
  expect(probe.endpointGeneration).toBe(generation);
  const tabUrl = (await tabs("a")).find((tab) => tab.id === env("a").serviceTabId)?.url;

  // Restart in the same terminal, as a user would: Ctrl-C, then the command.
  const sessionId = (await tabs("a")).find((tab) => tab.id === env("a").runTabId)?.sessionId;
  expect(sessionId, "the Run Commands tab's terminal session").toBeTruthy();
  await invoke("local_terminal_write", { sessionId, data: "\u0003" });
  await expect.poll(() => alive(pidOf(before)), { timeout: 30_000 }).toBe(false);
  await invoke("local_terminal_write", { sessionId, data: `${s().runCommand}\r` });

  // A new process holds the entry port.
  let after = "";
  await expect
    .poll(
      async () =>
        (after = await fetch(`http://127.0.0.1:${s().entryPort}/health`)
          .then((response) => response.json() as Promise<{ marker?: string }>)
          .then((body) => body.marker ?? "")
          .catch(() => "")),
      { timeout: 60_000, message: "the restarted dev server answers on the entry port" },
    )
    .toMatch(markerOf("a"));
  expect(after).not.toBe(before);
  s().devServerPids.add(pidOf(after));
  record(testInfo, "restart", `${before} -> ${after}`);

  // The fixture client reconnects and visibly renders the new process.
  await expectShown(markerOf("a"), { previous: before });
  // The service now points at the new process, at a newer generation.
  let lastEndpoint: unknown = null;
  await expect
    .poll(
      async () => {
        const { endpoint } = await seeded("a");
        lastEndpoint = {
          generation,
          now: endpoint.endpointGeneration,
          hostPort: endpoint.hostPort,
          listener: endpoint.listener,
          access: (await invoke<{ access: unknown }>("get_preview_diagnostics")).access,
        };
        return {
          newer: endpoint.endpointGeneration > generation,
          state: endpoint.state,
          ownership: endpoint.ownership,
        };
      },
      { timeout: 30_000, message: "the seeded service rebinds to the new process" },
    )
    .toEqual({ newer: true, state: "available", ownership: "managed-process" })
    .catch((error: Error) => {
      throw new Error(`${error.message}\n${JSON.stringify(lastEndpoint)}`);
    });

  // The fixture's own reconnect client rendered the new process in the same document.
  expect(await visiblePreviews()).toEqual([expect.objectContaining({ marker: after, documentId })]);

  expect(await activeTabId("a")).toBe(env("a").serviceTabId);
  expect((await tabs("a")).find((tab) => tab.id === env("a").serviceTabId)?.url).toBe(tabUrl);
  const renewal = await invoke("renew_preview_attachment", { attachmentId: probe.attachmentId })
    .then(() => "renewed")
    .catch((error: Error) => error.message);
  expect(renewal).toMatch(/access-expired|generation-changed/);
  record(testInfo, "old-generation", renewal.slice(0, 200));
});

test("6. fast restart refuses the old generation inside the verification window (3230)", async () => {
  await select("a");
  await activateTab("a", env("a").serviceTabId!);
  const before = await expectShown(markerOf("a"));
  const service = await seeded("a");
  await invoke("probe_preview_service", { serviceId: service.definition.serviceId });
  const generation = (await seeded("a")).endpoint.endpointGeneration;
  const startedAt = Date.now();
  const sessionId = (await tabs("a")).find((tab) => tab.id === env("a").runTabId)?.sessionId;
  await invoke("local_terminal_write", { sessionId, data: "\u0003" });
  await expect.poll(() => alive(pidOf(before))).toBe(false);
  await invoke("local_terminal_write", { sessionId, data: `${s().runCommand}\r` });
  let after: unknown;
  await expect
    .poll(
      async () => {
        after = await pageRequestMarker();
        return typeof after === "string" && after !== before && markerOf("a").test(after);
      },
      { intervals: [50] },
    )
    .toBe(true);
  s().devServerPids.add(pidOf(after as string));
  const current = await seeded("a");
  // Slower than this and the verification window would have expired anyway.
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(current.endpoint.endpointGeneration).toBeGreaterThan(generation);
});

test("4. ⌘⇧-click on a loopback link in an agent's reply opens a preview tab there, and a plain click opens the system browser", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const port = s().entryPort;
  await select("a");
  // The reply sits above the terminal, where no native preview covers it.
  await activateTab("a", env("a").runTabId!);
  await expect.poll(visiblePreviews).toEqual([]);
  await s().app.evaluate(({ shell }) => {
    const state = globalThis as any;
    state.__seededOpenExternal = shell.openExternal;
    state.__seededExternalUrls = [];
    shell.openExternal = async (url: string) => {
      state.__seededExternalUrls.push(url);
    };
  });
  try {
    await s().window.evaluate(
      async ({ environmentId, tabId, url }) => {
        // Reuse the app's versioned Vite URLs so hooks use its React singleton.
        const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
        const reactPath = resources.find((name) => name.includes("/deps/react.js?"))!;
        const rootPath = resources.find((name) => name.includes("/deps/react-dom_client.js?"))!;
        const markdownPath = "/src/components/chat/MessageMarkdown.tsx";
        const contextPath = "/src/components/chat/link-source-context.ts";
        const { default: React } = await import(reactPath);
        const { default: ReactDOM } = await import(rootPath);
        const { MessageMarkdown } = await import(markdownPath);
        const { PreviewLinkSourceContext } = await import(contextPath);
        const mount = document.createElement("div");
        mount.id = "seeded-agent-reply";
        Object.assign(mount.style, {
          position: "fixed",
          left: "320px",
          bottom: "24px",
          zIndex: "999999",
          padding: "8px",
          background: "#111",
        });
        document.body.append(mount);
        const root = ReactDOM.createRoot(mount);
        root.render(
          React.createElement(
            PreviewLinkSourceContext.Provider,
            { value: { environmentId, tabId } },
            React.createElement(MessageMarkdown, {
              content: `The server is up at [the app](${url}).`,
            }),
          ),
        );
        window.addEventListener(
          "cleanup-seeded-agent-reply",
          () => {
            root.unmount();
            mount.remove();
          },
          { once: true },
        );
      },
      { environmentId: env("a").id, tabId: env("a").runTabId!, url: `http://localhost:${port}/` },
    );
    const link = s().window.locator("#seeded-agent-reply a", { hasText: "the app" });
    await expect(link).toBeVisible();

    // A plain click keeps its default: the system browser (captured here).
    const tabCount = (await tabs("a")).length;
    await link.click();
    await expect
      .poll(() => s().app.evaluate(() => (globalThis as any).__seededExternalUrls as string[]))
      .toEqual([`http://localhost:${port}/`]);
    expect((await tabs("a")).length).toBe(tabCount);

    // The gesture opens a preview tab in this environment, on its own server.
    const agentTab = await newTab("a", "browser", () =>
      link.click({ modifiers: ["ControlOrMeta", "Shift"] }),
    );
    await expect.poll(() => activeTabId("a")).toBe(agentTab);
    const serviceId = (await seeded("a")).definition.serviceId;
    await expect
      .poll(async () => (await tabs("a")).find((tab) => tab.id === agentTab)?.url ?? "", {
        timeout: 30_000,
      })
      .toContain(serviceId);
    record(testInfo, "agent-link", await expectShown(markerOf("a")));
    expect(
      await s().app.evaluate(() => ((globalThis as any).__seededExternalUrls as string[]).length),
    ).toBe(1);
  } finally {
    await s()
      .window.evaluate(() => window.dispatchEvent(new Event("cleanup-seeded-agent-reply")))
      .catch(() => undefined);
    await s().app.evaluate(({ shell }) => {
      const state = globalThis as any;
      shell.openExternal = state.__seededOpenExternal;
      delete state.__seededOpenExternal;
      delete state.__seededExternalUrls;
    });
  }
});

test("5. route details show the private origin in framework hints when publication is on, and Copy puts the snippet on the clipboard", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const pki = path.join(s().temporaryRoot, "pki");
  await mkdir(pki, { recursive: true });
  certificates(pki);
  const clipboard = await s().app.evaluate(({ clipboard }) => clipboard.readText());
  await invoke("update_preview_settings", {
    settings: {
      publication: {
        enabled: true,
        domain: TEST_PREVIEW_DOMAIN,
        certFile: path.join(pki, "leaf.pem"),
        keyFile: path.join(pki, "leaf.key"),
        listenAddress: "127.0.0.1",
        port: 0,
      },
    },
  });
  try {
    const serviceId = (await seeded("a")).definition.serviceId;
    let origin = "";
    await expect
      .poll(
        async () =>
          (origin =
            (await invoke<{ origin: string | null }>("get_preview_public_origin", { serviceId }))
              .origin ?? ""),
        { timeout: 30_000, message: "the service is published on a private origin" },
      )
      .toMatch(
        new RegExp(`^https://s-[0-9a-f]{20}\\.${TEST_PREVIEW_DOMAIN.replace(".", "\\.")}:\\d+$`),
      );

    await select("a");
    await activateTab("a", env("a").serviceTabId!);
    await expectShown(markerOf("a"));
    await s().window.getByRole("button", { name: "Route details" }).click();
    await s().window.getByRole("button", { name: "Framework setup hints" }).click();
    const hints = s().window.getByTestId("preview-framework-hints");
    await expect(hints).toContainText(`Public origin ${origin}.`);
    await expect(hints).toContainText(`Host: localhost:${s().entryPort}`);
    await expect(hints).toContainText(`PUBLIC_ORIGIN=${origin}`);
    await hints.getByRole("button", { name: "Copy the Next.js snippet" }).click();
    await expect
      .poll(() => s().app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`PUBLIC_ORIGIN=${origin}`);
    record(testInfo, "public-origin", origin);
  } finally {
    await s()
      .app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboard)
      .catch(() => undefined);
    await invoke("update_preview_settings", { settings: { publication: { enabled: false } } });
  }
});
