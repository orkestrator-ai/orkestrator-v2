/**
 * Real-stack service previews in the actual Electron main process, with the
 * desktop tunnel enabled (`ORKESTRATOR_PREVIEW_TRANSPORT=1`).
 *
 * Launches Electron with a disposable agent-test profile under a temporary
 * root (never the user's profile or backend data), registers two worktree
 * services backed by the synthetic preview fixture (`test-fixtures/preview-app`),
 * and opens them through the production preload API and through service tabs
 * the real renderer mounts. Every page byte crosses the per-service loopback
 * ingress and the backend tunnel; nothing loads the legacy loopback route.
 *
 * Covers (docs/todo/previews-and-annotations/0042-service-preview-rollout.md, "Real Electron window"):
 * credentialed ingress and header injection for HTTP and WebSocket requests,
 * including worker-originated fetches; cookie, localStorage, IndexedDB and
 * service-worker isolation between two services; hide and reattach, and a
 * renderer reload, without reloading the page; history, app zoom, DevTools,
 * screenshots and an annotation capture after reattach; a preview renderer
 * crash and reload; stable resource counts over repeated open, hide and close,
 * and full release after the retirement lease. Then: Edit-menu copy and paste
 * and gated page clipboard access; overlays (menus, the service dialog, the
 * project search) hiding the view; keyboard use of the picker, service dialog,
 * diagnostics and Cmd/Ctrl+L; the narrowest window at 100 and 150 % zoom; a
 * Vite application updated by HMR while its tab is hidden, unmounted and
 * reloaded; and a second window on a second backend (a disposable standalone
 * backend) with connection switches and window close releasing on the
 * backend that issued each attachment.
 */
import type { Page, TestInfo } from "@playwright/test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrowserPreviewPendingCapture,
  BrowserPreviewSelectionStatus,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { PREVIEW_ERROR_HEADER } from "@orkestrator/protocol/node/preview-forward";
import { PREVIEW_INGRESS_HEADER } from "@orkestrator/protocol/preview-access";
import { formatPreviewServiceUri } from "@orkestrator/protocol/preview-services";

import { BackendHttpClient, BackendProcess } from "../../apps/desktop/electron/backend-process";
import {
  browserPreviewServicePartition,
  browserPreviewPartitionForWindow,
} from "../../apps/desktop/electron/desktop-window-lifecycle";
import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { startPreviewFixture, type PreviewFixture } from "../../test-fixtures/preview-app/server";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");
const BOUNDS = { x: 0, y: 0, width: 960, height: 640 };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** `a` and `b` are local fixtures, `r` a fixture on a second backend, `v` a Vite app. */
type Name = "a" | "b" | "r" | "v";

interface Service {
  marker: string;
  /** The synthetic fixture, or null for the Vite application. */
  fixture: PreviewFixture | null;
  port: number;
  serviceId: string;
  backendInstanceId: string;
  environmentId: string;
}

interface RemoteBackend {
  process: BackendProcess;
  address: string;
  /** The disposable backend's gateway token; never logged or recorded. */
  token: string;
  backendInstanceId: string;
}

interface Stack {
  temporaryRoot: string;
  profile: RuntimeProfile;
  profilePath: string;
  rendererUrl: string;
  vite: ChildProcess;
  app: ElectronApplication;
  window: Page;
  /** The main window's `BrowserWindow.id`. */
  windowId: number;
  projectId: string;
  environmentId: string;
  backendInstanceId: string;
  services: Partial<Record<Name, Service>>;
  /** Ingress origin per service, from its latest attach (stable via port hints). */
  origins: Partial<Record<Name, string>>;
  remote: RemoteBackend | null;
  /** Owned before startup/setup awaits, including when capability checks fail. */
  remoteProcess: BackendProcess | null;
  viteApp: ViteApp | null;
}

interface ViteApp {
  process: ChildProcess;
  root: string;
  port: number;
}

interface ViewInfo {
  url: string;
  visible: boolean;
  crashed: boolean;
  storagePath: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}

let stack: Stack | null = null;
const outputTails = new WeakMap<ElectronApplication, () => string>();

function s(): Stack {
  if (!stack) throw new Error("Service preview stack is not running");
  return stack;
}

function svc(name: Name): Service {
  const service = s().services[name];
  if (!service) throw new Error(`Service ${name} is not registered`);
  return service;
}

function fixtureOf(name: Name): PreviewFixture {
  const fixture = svc(name).fixture;
  if (!fixture) throw new Error(`Service ${name} has no synthetic fixture`);
  return fixture;
}

function origin(name: Name): string {
  const value = s().origins[name];
  if (!value) throw new Error(`Service ${name} has not been attached yet`);
  return value;
}

function record(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function waitForApi(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window
          .evaluate(async () => {
            const api = (globalThis as any).orkestrator;
            if (!api?.invoke) return false;
            await api.invoke("greet", { name: "service-previews" });
            return true;
          })
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function launchElectron(current: Pick<Stack, "profile" | "profilePath" | "rendererUrl">) {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [
      ...ELECTRON_TEST_SWITCHES,
      // Other worktrees' windows can cover this one on a shared desktop.
      // Chromium then throttles its timers, and Radix menus move keyboard
      // focus in a timer (flake 0620). A user never types into a covered window.
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      path.join(packageRoot, "dist", "electron", "main.js"),
    ],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ELECTRON_DEV: "1",
      VITE_DEV_SERVER_URL: current.rendererUrl,
      ORKESTRATOR_RUNTIME_PROFILE_FILE: current.profilePath,
      // The rollout gate under test: the desktop tunnel, off by default.
      ORKESTRATOR_PREVIEW_TRANSPORT: "1",
      // Never contend for the fixed control-MCP port an installed app may own.
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    },
  });
  dismissStartupDialogs(app);
  // A bounded tail of main-process output, for startup diagnostics only.
  let tail = "";
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4_000);
  };
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  outputTails.set(app, () => tail);
  const window = await app.firstWindow({ timeout: 90_000 }).catch((error: Error) => {
    throw new Error(`${error.message}\nElectron output tail:\n${tail}`);
  });
  await expect(window).toHaveTitle(current.profile.electronTitle, { timeout: 60_000 });
  await waitForApi(window);
  const windowId = await (
    await app.browserWindow(window)
  ).evaluate((host) => {
    host.setSize(1440, 960);
    return host.id;
  });
  return { app, window, windowId };
}

function childPids(parent: number): number[] {
  const processes = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (processes.status !== 0) return [];
  return processes.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => ppid === parent && Number.isInteger(pid))
    .map(([pid]) => pid!);
}

/** Every descendant of `root`: the `.bin/electron` wrapper spawns the real binary. */
function descendantPids(root: number): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < 512) {
    for (const pid of childPids(queue.shift()!)) {
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Quit Electron normally and wait until its supervised children (backend) are gone. */
async function closeElectron(): Promise<void> {
  const app = s().app;
  const child = app.process();
  const children = child.pid ? descendantPids(child.pid) : [];
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  await Promise.race([
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  const graceful = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!graceful) {
    test.info().annotations.push({
      type: "electron-quit",
      description:
        `app.quit() did not exit within 30s; output tail: ${outputTails.get(app)?.() ?? ""}`.slice(
          0,
          2_000,
        ),
    });
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    for (const pid of children.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await closeElectronWithin(app, 10_000);
  await expect.poll(() => children.filter(alive).length, { timeout: 20_000 }).toBe(0);
}

const invokeIn = <T>(page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(({ command, args }) => (globalThis as any).orkestrator.invoke(command, args), {
    command,
    args,
  }) as Promise<T>;

const invoke: Invoke = (command, args = {}) => invokeIn(s().window, command, args);

/** The production preload preview API (`window.orkestrator.browserPreview`) of `page`. */
function previewIn<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method, args }) => {
      const api = (globalThis as any).orkestrator.browserPreview;
      const target = method in api ? api : api.capture;
      return target[method](...args);
    },
    { method, args },
  );
}

function preview<T>(method: string, ...args: unknown[]): Promise<T> {
  return previewIn<T>(s().window, method, ...args);
}

function serviceTarget(name: Name, routePath = "/") {
  const service = svc(name);
  return {
    backendInstanceId: service.backendInstanceId,
    environmentId: service.environmentId,
    serviceId: service.serviceId,
    path: routePath,
  };
}

async function attachService(name: Name, tabId: string, visible = true, page = s().window) {
  const state = await previewIn<BrowserPreviewState>(page, "attach", {
    tabId,
    service: serviceTarget(name),
    bounds: BOUNDS,
    visible,
  });
  // The view reports its URL once the first navigation commits. The ingress
  // port is hinted, but a released ingress may come back on another port.
  let current = state;
  await expect
    .poll(
      async () => {
        current =
          (await previewIn<BrowserPreviewState | null>(page, "setVisible", tabId, visible)) ??
          state;
        return current.url;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^http:\/\//);
  s().origins[name] = new URL(current.url).origin;
  return current;
}

/** Every native preview view on a window (the main one by default) whose URL is on `viewOrigin`. */
function viewsOn(viewOrigin: string, windowId = s().windowId): Promise<ViewInfo[]> {
  return s().app.evaluate(
    ({ BrowserWindow }, { viewOrigin, windowId }) => {
      const host = BrowserWindow.fromId(windowId);
      const views: ViewInfo[] = [];
      for (const child of host?.contentView.children ?? []) {
        const view = child as unknown as {
          getVisible(): boolean;
          getBounds(): ViewInfo["bounds"];
          webContents?: {
            isDestroyed(): boolean;
            isCrashed(): boolean;
            getURL(): string;
            session: { getStoragePath(): string | null };
          };
        };
        const contents = view.webContents;
        if (!contents || contents.isDestroyed() || !contents.getURL().startsWith(viewOrigin))
          continue;
        views.push({
          url: contents.getURL(),
          visible: view.getVisible(),
          crashed: contents.isCrashed(),
          storagePath: contents.session.getStoragePath(),
          bounds: view.getBounds(),
        });
      }
      return views;
    },
    { viewOrigin, windowId },
  );
}

/** Evaluate in the (single) preview page on a service's ingress origin. */
function inService<T>(name: Name, script: string): Promise<T> {
  return s().app.evaluate(
    async ({ webContents }, { viewOrigin, script }) => {
      const matches = webContents
        .getAllWebContents()
        .filter(
          (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin),
        );
      if (matches.length !== 1) throw new Error(`Expected one preview, found ${matches.length}`);
      return matches[0]!.executeJavaScript(script, true);
    },
    { viewOrigin: origin(name), script },
  ) as Promise<T>;
}

/** Run `action` on the main-process web contents of a service's preview. */
function onServiceContents<T>(
  name: Name,
  action: "crash" | "isCrashed" | "isDevToolsOpened" | "closeDevTools" | "capturePage",
): Promise<T> {
  return s().app.evaluate(
    async ({ webContents }, { viewOrigin, action }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin));
      if (!contents) throw new Error("Service preview web contents not found");
      switch (action) {
        case "crash":
          contents.forcefullyCrashRenderer();
          return true;
        case "isCrashed":
          return contents.isCrashed();
        case "isDevToolsOpened":
          return contents.isDevToolsOpened();
        case "closeDevTools":
          contents.closeDevTools();
          return true;
        case "capturePage": {
          const image = await contents.capturePage();
          return { ...image.getSize(), empty: image.isEmpty(), png: image.toPNG().length };
        }
      }
    },
    { viewOrigin: origin(name), action },
  ) as Promise<T>;
}

/** Wait for a service's page on `routePath`, or on any path when it is null. */
async function waitForService(name: Name, routePath: string | null = "/"): Promise<void> {
  const marker = svc(name).marker;
  const onPath = routePath === null ? "true" : `location.pathname === ${JSON.stringify(routePath)}`;
  const ready = () =>
    inService<boolean>(
      name,
      `document.readyState === "complete" && document.body?.dataset.loaded === ${JSON.stringify(marker)} && ${onPath}`,
    ).catch(() => false);
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      // Enough page state to tell a wrong page, an error body and a stall apart.
      const page = await inService<unknown>(
        name,
        `({ path: location.pathname, readyState: document.readyState, loaded: document.body?.dataset.loaded ?? null, text: (document.body?.innerText ?? "").slice(0, 200) })`,
      ).catch((error: Error) => error.message);
      const requests = (svc(name).fixture?.requests ?? []).map((entry) => entry.path);
      throw new Error(
        `Service ${name} did not load ${routePath}: ${JSON.stringify({ page, requests: requests.slice(-12) })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Total live web contents in main (windows, previews, DevTools, workers' hosts). */
function webContentsCount(): Promise<number> {
  return s().app.evaluate(
    ({ webContents }) =>
      webContents.getAllWebContents().filter((item) => !item.isDestroyed()).length,
  );
}

async function accessStats(): Promise<{ attachments: number; resources: number }> {
  const diagnostics = await invoke<{ access: { attachments: number; resources: number } }>(
    "get_preview_diagnostics",
  );
  return diagnostics.access;
}

/** A plain request to an ingress, with no partition hook to add its credential. */
function rawIngress(
  ingressOrigin: string,
  options: { headers?: Record<string, string>; upgrade?: boolean } = {},
): Promise<{ status: number; category: string | undefined }> {
  const url = new URL(ingressOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: options.upgrade ? "/ws" : "/health",
      headers: {
        ...(options.upgrade
          ? {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            }
          : {}),
        ...options.headers,
      },
    });
    request.once("response", (response) => {
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        category: response.headers[PREVIEW_ERROR_HEADER] as string | undefined,
      });
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, category: undefined });
    });
    request.once("error", reject);
    request.end();
  });
}

async function uiStore(action: string, ...args: unknown[]): Promise<void> {
  await s().window.evaluate(
    async ({ action, args }) => {
      const modulePath = "/src/stores/uiStore.ts";
      const { useUIStore } = await import(modulePath);
      (useUIStore.getState() as Record<string, (...values: unknown[]) => void>)[action]!(...args);
    },
    { action, args },
  );
}

const UI_TABS: Record<Name, string> = {
  a: "service-ui-tab-a",
  b: "service-ui-tab-b",
  r: "service-ui-tab-r",
  v: "service-ui-tab-v",
};
/** The services `showServiceTabs` last laid out, in tab order. */
let uiTabOrder: Name[] = ["a", "b"];

/** Show the environment with one service tab per service, rendered by the real renderer. */
async function showServiceTabs(active: Name, names: Name[] = ["a", "b"]): Promise<void> {
  for (const name of names) {
    if (s().origins[name]) continue;
    // Learn the ingress origin; the tab then reuses the same service group.
    await attachService(name, `origin-probe-${name}`, false);
    await preview("destroy", `origin-probe-${name}`);
  }
  const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: s().environmentId,
  });
  await invoke("save_pane_layout", {
    environmentId: s().environmentId,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "service-ui-pane",
      root: {
        kind: "leaf",
        id: "service-ui-pane",
        activeTabId: UI_TABS[active],
        tabs: names.map((name) => ({
          id: UI_TABS[name],
          type: "browser",
          browserData: { url: formatPreviewServiceUri(serviceTarget(name)) },
        })),
      },
    },
  });
  // An open renderer keeps the tab set it already hydrated rather than this
  // external save (docs/todo/previews-and-annotations/0042-service-preview-rollout.md, code item 9), so a
  // different set needs a fresh renderer.
  const reload = names.join() !== uiTabOrder.join();
  uiTabOrder = names;
  if (reload) {
    await s().window.reload();
    await waitForApi(s().window);
  }
  await uiStore("selectProjectAndEnvironment", s().projectId, s().environmentId);
  await closeStartupDialogs();
}

/**
 * An open dialog correctly hides native previews. The startup-dialog handlers
 * (`dismissStartupDialogs`) run only before a Playwright locator action or
 * assertion, never during main-process polls, so give them one.
 */
async function closeStartupDialogs(): Promise<void> {
  await expect(s().window.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
}

/**
 * The pane tab strip entry for a service tab, in layout order. Service tabs
 * are named after their service (its label is the fixture marker).
 */
function uiTab(name: Name) {
  const index = uiTabOrder.indexOf(name) + 1;
  const label = s().services[name]!.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s()
    .window.getByRole("button", { name: new RegExp(`^${label} ${index} `) })
    .first();
}

/** The service's native view is visible on its renderer host, within whole-DIP rounding. */
async function expectViewOnHost(
  service: Name,
  tabId: string,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  let last: unknown = null;
  await expect
    .poll(
      async () => {
        const zoom = await s().app.evaluate(
          ({ BrowserWindow }, windowId) =>
            BrowserWindow.fromId(windowId)!.webContents.getZoomFactor(),
          s().windowId,
        );
        const host = await s().window.evaluate((tabId) => {
          const rect = document
            .querySelector(`[data-native-browser-preview="${tabId}"]`)
            ?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        }, tabId);
        const [view] = await viewsOn(origin(service));
        last = { zoom, host, view: view?.bounds };
        if (!view?.visible || !host) return false;
        return (
          Math.abs(view.bounds.x - host.x * zoom) <= 1.5 &&
          Math.abs(view.bounds.y - host.y * zoom) <= 1.5 &&
          Math.abs(view.bounds.width - host.width * zoom) <= 1.5 &&
          Math.abs(view.bounds.height - host.height * zoom) <= 1.5
        );
      },
      { timeout: 20_000, message: `${label}: native view off its host` },
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`${error.message}\n${JSON.stringify(last)}`);
    });
  record(testInfo, `bounds-${label}`, JSON.stringify(last));
}

/**
 * Visibility of a service's views. A startup dialog can open at any point
 * after a launch or renderer reload, and it correctly hides native views, so
 * each read first gives the dialog handlers a locator assertion to run on.
 */
async function visibility(name: Name): Promise<boolean[]> {
  await expect(s().window.getByRole("dialog"))
    .toHaveCount(0, { timeout: 1_000 })
    .catch(() => undefined);
  return (await viewsOn(origin(name))).map((view) => view.visible);
}

/** Poll a service's view visibility; on a miss, record what covers the window. */
async function expectVisibility(name: Name, expected: boolean[], timeout = 30_000): Promise<void> {
  await expect
    .poll(() => visibility(name), { timeout })
    .toEqual(expected)
    .catch(async (error: Error) => {
      const page = await s()
        .window.locator("body")
        .ariaSnapshot({ timeout: 5_000 })
        .catch(() => "unavailable");
      throw new Error(`${error.message}\nRenderer:\n${page.slice(0, 4_000)}`);
    });
}

/** Register a worktree service on the backend `invokeOn` reaches. */
async function registerService(
  invokeOn: Invoke,
  service: Omit<Service, "serviceId">,
  readinessPath = "/health",
): Promise<Service> {
  const created = await invokeOn<{ kind: string; definition?: { serviceId: string } }>(
    "register_preview_service",
    {
      service: {
        environmentId: service.environmentId,
        label: service.marker,
        targetKind: "worktree",
        applicationPort: service.port,
        addressFamily: "ipv4",
        readinessPath,
      },
      operationId: `register-${service.marker}`,
    },
  );
  expect(created.kind).toBe("definition");
  return { ...service, serviceId: created.definition!.serviceId };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.info().setTimeout(300_000);
  // Bundle exactly as production and the dev launcher do.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-service-preview-"));
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "service-preview-smoke",
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
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_DEV_HOST: "127.0.0.1",
      VITE_DEV_PORT: String(rendererPort),
      VITE_ORKESTRATOR_PROFILE: profile.id,
    },
  });
  ownProcessGroup(vite);
  const partial = {
    temporaryRoot,
    profile,
    profilePath,
    rendererUrl,
    vite,
    origins: {},
    services: {},
    remote: null,
    remoteProcess: null,
    viteApp: null,
  } as unknown as Stack;
  stack = partial;
  const fixtures = await Promise.all(
    (["svc-a", "svc-b"] as const).map((marker) => startPreviewFixture({ marker })),
  );
  // Closed by `afterAll` even if registration never happens.
  partial.services = {
    a: { marker: "svc-a", fixture: fixtures[0]!, port: fixtures[0]!.port } as Service,
    b: { marker: "svc-b", fixture: fixtures[1]!, port: fixtures[1]!.port } as Service,
  };
  await waitForUrl(rendererUrl);
  const { app, window, windowId } = await launchElectron(partial);
  partial.app = app;
  partial.window = window;
  partial.windowId = windowId;

  const projectPath = await prepareFixtureRepository(profile, templateRoot);
  const project = await invoke<{ id: string }>("add_project", {
    gitUrl: path.join(profile.fixtureDir, "origin.git"),
    localPath: projectPath,
  });
  const environment = await invoke<{ id: string }>("create_environment", {
    projectId: project.id,
    name: "service-preview-fixture",
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  await invoke("start_environment", { environmentId: environment.id });
  partial.projectId = project.id;
  partial.environmentId = environment.id;
  const capabilities = await invoke<{ backendInstanceId: string }>("get_preview_capabilities");
  partial.backendInstanceId = capabilities.backendInstanceId;
  for (const name of ["a", "b"] as const) {
    const service = partial.services[name]!;
    partial.services[name] = await registerService(invoke, {
      marker: service.marker,
      fixture: service.fixture,
      port: service.port,
      environmentId: environment.id,
      backendInstanceId: capabilities.backendInstanceId,
    });
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
  if (running) await closeElectron().catch(() => undefined);
  stack = null;
  await current.remoteProcess?.stop().catch(() => undefined);
  if (current.viteApp) await stopProcessGroup(current.viteApp.process).catch(() => undefined);
  for (const service of Object.values(current.services ?? {})) {
    await service.fixture?.close().catch(() => undefined);
  }
  if (current.vite) await stopProcessGroup(current.vite).catch(() => undefined);
  await rm(current.temporaryRoot, { recursive: true, force: true });
});

test("the tunnel is advertised and a service loads through its credentialed loopback ingress", async () => {
  const testInfo = test.info();
  const settings = await invoke<{
    stored: { transport: boolean };
    effective: { transport: boolean };
  }>("get_preview_settings");
  // The override reached the isolated backend; nothing was written to the profile.
  expect(settings.effective.transport).toBe(true);
  expect(settings.stored.transport).toBe(false);
  const capabilities = await invoke<{
    surfaces: { desktopTunnel: { available: boolean; reason?: string } };
  }>("get_preview_capabilities");
  expect(capabilities.surfaces.desktopTunnel).toMatchObject({ available: true });

  const fixture = fixtureOf("a");
  const state = await attachService("a", "service-a");
  const ingress = new URL(state.url);
  record(testInfo, "attach-state", JSON.stringify({ ...state, url: `${ingress.origin}/` }));
  expect(ingress.hostname).toBe("127.0.0.1");
  expect(Number(ingress.port)).not.toBe(fixture.port);
  expect(state.service).toMatchObject({
    serviceId: svc("a").serviceId,
    path: "/",
    displayUrl: `http://localhost:${fixture.port}/`,
  });
  expect(state.transport).toEqual({ mode: "desktop-tunnel", state: "ready" });
  await waitForService("a");

  const [view] = await viewsOn(origin("a"));
  expect(view?.visible).toBe(true);
  // Its own persistent service partition, not the shared legacy preview session.
  expect(view?.storagePath ?? "").toContain("orkestrator-preview-svc-");

  // The application saw its own private authority and no transport credential.
  const page = fixture.requests.find((entry) => entry.path === "/");
  expect(page).toBeDefined();
  expect(page!.host).toBe(`localhost:${fixture.port}`);
  expect(page!.headerNames).not.toContain(PREVIEW_INGRESS_HEADER);
  expect(page!.authorization).toBeUndefined();
  expect(page!.cookie ?? "").not.toMatch(/orkestrator/i);

  // Port secrecy is not authentication: requests without the injected
  // credential, or with a forged one, are refused for HTTP and WebSocket.
  expect(await rawIngress(origin("a"))).toEqual({ status: 403, category: "forbidden" });
  expect(
    await rawIngress(origin("a"), { headers: { [PREVIEW_INGRESS_HEADER]: "x".repeat(43) } }),
  ).toEqual({ status: 403, category: "forbidden" });
  expect(await rawIngress(origin("a"), { upgrade: true })).toEqual({
    status: 403,
    category: "forbidden",
  });

  // A legacy (shared-partition) tab pointed at the ingress gets no credential either.
  const before = fixture.requests.length;
  await preview("attach", {
    tabId: "legacy-probe",
    url: `${origin("a")}/`,
    bounds: BOUNDS,
    visible: true,
  });
  await expect
    .poll(async () => {
      const views = await viewsOn(origin("a"));
      return views.some((item) => !item.storagePath?.includes("orkestrator-preview-svc-"));
    })
    .toBe(true);
  await preview("destroy", "legacy-probe");
  expect(fixture.requests.length).toBe(before);
});

test("WebSocket upgrades cross the tunnel with the subprotocol and no ingress credential", async () => {
  const fixture = fixtureOf("a");
  const result = await inService<{ protocol: string; messages: string[] }>(
    "a",
    `new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://" + location.host + "/ws", "fixture.v1");
      const messages = [];
      const timer = setTimeout(() => reject(new Error("WebSocket timed out")), 15000);
      socket.onmessage = (event) => {
        messages.push(String(event.data));
        if (messages.length === 1) socket.send("echo-through-tunnel");
        else { clearTimeout(timer); socket.close(); resolve({ protocol: socket.protocol, messages }); }
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket failed")); };
    })`,
  );
  expect(result.protocol).toBe("fixture.v1");
  expect(JSON.parse(result.messages[0]!)).toEqual({ hello: "svc-a", protocol: "fixture.v1" });
  expect(result.messages[1]).toBe("echo-through-tunnel");
  const upgrade = fixture.requests.filter((entry) => entry.path === "/ws").at(-1);
  expect(upgrade).toBeDefined();
  expect(upgrade!.headerNames).not.toContain(PREVIEW_INGRESS_HEADER);
  expect(upgrade!.host).toBe(`localhost:${fixture.port}`);
  expect(upgrade!.origin).toBe(`http://localhost:${fixture.port}`);
});

test("two services never share cookies, localStorage, IndexedDB or service workers", async () => {
  const testInfo = test.info();
  await attachService("b", "service-b");
  await waitForService("b");
  const [viewA] = await viewsOn(origin("a"));
  const [viewB] = await viewsOn(origin("b"));
  expect(viewA!.storagePath).not.toBe(viewB!.storagePath);

  await inService(
    "a",
    `(async () => {
      document.cookie = "iso=svc-a; path=/";
      localStorage.setItem("iso", "svc-a");
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("iso-db", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("items");
        open.onsuccess = () => {
          const write = open.result.transaction("items", "readwrite");
          write.objectStore("items").put("svc-a", "owner");
          write.oncomplete = () => { open.result.close(); resolve(true); };
          write.onerror = () => reject(write.error);
        };
        open.onerror = () => reject(open.error);
      });
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      return true;
    })()`,
  );
  // The worker claims the page; its synthetic response proves it is live in A.
  await expect
    .poll(() =>
      inService<string | null>(
        "a",
        `navigator.serviceWorker.controller ? fetch("/sw/marker").then((r) => r.json()).then((b) => b.worker) : null`,
      ).catch(() => null),
    )
    .toBe("svc-a");
  const echoA = await inService<{ cookie: string | null }>(
    "a",
    `fetch("/cookies/echo").then((r) => r.json())`,
  );
  expect(echoA.cookie).toContain("iso=svc-a");

  const seenFromB = await inService<{
    cookie: string;
    local: string | null;
    databases: string[];
    workers: number;
    workerProbe: number;
    serverCookie: string | null;
  }>(
    "b",
    `(async () => ({
      cookie: document.cookie,
      local: localStorage.getItem("iso"),
      databases: (await indexedDB.databases()).map((db) => db.name),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
      workerProbe: (await fetch("/sw/marker")).status,
      serverCookie: (await fetch("/cookies/echo").then((r) => r.json())).cookie,
    }))()`,
  );
  record(testInfo, "seen-from-b", JSON.stringify(seenFromB));
  expect(seenFromB).toEqual({
    cookie: "",
    local: null,
    databases: [],
    workers: 0,
    workerProbe: 404,
    serverCookie: null,
  });

  // A reload of A is served through its worker, whose network fetches must
  // still carry the partition's ingress credential (worker-originated requests).
  const fixtureA = fixtureOf("a");
  const before = fixtureA.requests.filter((entry) => entry.path === "/").length;
  await inService("a", `window.__beforeReload = true; true`);
  await preview("reload", "service-a");
  await expect
    .poll(() =>
      inService<boolean>(
        "a",
        `document.readyState === "complete" && document.body?.dataset.loaded === "svc-a" && !window.__beforeReload && Boolean(navigator.serviceWorker.controller)`,
      ).catch(() => false),
    )
    .toBe(true);
  expect(fixtureA.requests.filter((entry) => entry.path === "/").length).toBeGreaterThan(before);
  expect(
    fixtureA.requests.filter((entry) => entry.headerNames.includes(PREVIEW_INGRESS_HEADER)),
  ).toEqual([]);
});

test("service tabs hide and reattach, and survive a renderer reload, without reloading the page", async () => {
  // Hand the services to tabs the real renderer mounts.
  await preview("destroy", "service-a");
  await preview("destroy", "service-b");
  await expect.poll(async () => (await viewsOn(origin("a"))).length).toBe(0);
  await showServiceTabs("a");
  await expectVisibility("a", [true]);
  await waitForService("a");
  const address = s().window.getByRole("textbox", { name: "Browser address" }).first();
  await expect(address).toHaveValue(`http://localhost:${fixtureOf("a").port}/`);
  await inService("a", `window.__kept = "svc-a"; true`);

  await uiTab("b").click();
  await expectVisibility("b", [true]);
  await expectVisibility("a", [false]);
  await waitForService("b");
  await uiTab("a").click();
  await expectVisibility("a", [true]);
  await expectVisibility("b", [false]);
  expect(await inService<string>("a", "window.__kept")).toBe("svc-a");

  await s().window.reload();
  await waitForApi(s().window);
  await uiStore("selectProjectAndEnvironment", s().projectId, s().environmentId);
  await closeStartupDialogs();
  await expectVisibility("a", [true]);
  // The reattached tab reuses the live view: the application never reloaded.
  expect(await inService<string>("a", "window.__kept")).toBe("svc-a");
  await expect(s().window.getByRole("textbox", { name: "Browser address" }).first()).toHaveValue(
    `http://localhost:${fixtureOf("a").port}/`,
  );
});

test("history, app zoom, DevTools, screenshots and capture work after reattach", async () => {
  const testInfo = test.info();
  const tabId = UI_TABS.a;
  await inService("a", `location.assign("/app/next"); true`);
  await waitForService("a", "/app/next");
  await preview("goBack", tabId);
  await waitForService("a", "/");
  // A re-attach carrying the renderer's previous path, or a late echo of the
  // tab's own saved path, must not undo Back (the view used to bounce between
  // the two paths).
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await waitForService("a", "/");
  const forward = await preview<BrowserPreviewState>("goForward", tabId);
  await waitForService("a", "/app/next");
  expect(forward.transport?.mode).toBe("desktop-tunnel");
  await expect(s().window.getByRole("textbox", { name: "Browser address" }).first()).toHaveValue(
    `http://localhost:${fixtureOf("a").port}/app/next`,
  );

  // At every app zoom the native view sits on the renderer's preview host
  // (whose CSS rect main scales by the host zoom), and the page is kept.
  for (const level of [125, 80, 100]) {
    await uiStore("setZoomLevel", level);
    try {
      await expectViewOnHost("a", tabId, testInfo, `zoom-${level}`);
      await waitForService("a", "/app/next");
    } finally {
      if (level !== 100) await uiStore("setZoomLevel", 100).catch(() => undefined);
    }
  }

  await preview("openDevTools", tabId);
  await expect.poll(() => onServiceContents<boolean>("a", "isDevToolsOpened")).toBe(true);
  await onServiceContents("a", "closeDevTools");
  await expect.poll(() => onServiceContents<boolean>("a", "isDevToolsOpened")).toBe(false);

  const shot = await onServiceContents<{
    width: number;
    height: number;
    empty: boolean;
    png: number;
  }>("a", "capturePage");
  record(testInfo, "screenshot", JSON.stringify(shot));
  expect(shot.empty).toBe(false);
  expect(shot.width).toBeGreaterThan(100);
  expect(shot.png).toBeGreaterThan(1_000);

  // An annotation capture records the service identity, not the ingress URL.
  const rect = await inService<{ x: number; y: number; width: number; height: number }>(
    "a",
    `(() => { const r = document.querySelector("h1").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
  const started = await preview<BrowserPreviewSelectionStatus>("startCapture", {
    tabId,
    mode: "element",
    environmentId: s().environmentId,
  });
  expect(started.status).toBe("selecting");
  await s().app.evaluate(
    async ({ webContents }, { viewOrigin, x, y }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin));
      if (!contents) throw new Error("Service preview web contents not found");
      const point = { x: Math.round(x), y: Math.round(y) };
      contents.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 60));
      contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    },
    { viewOrigin: origin("a"), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  );
  let status: BrowserPreviewSelectionStatus = started;
  await expect
    .poll(
      async () => {
        status = await preview<BrowserPreviewSelectionStatus>("getCaptureStatus", tabId);
        return status.status;
      },
      { timeout: 20_000 },
    )
    .toMatch(/^(captured|error)$/);
  if (status.status !== "captured") throw new Error(`Capture failed: ${JSON.stringify(status)}`);
  const pending = await preview<BrowserPreviewPendingCapture | null>(
    "readPendingCapture",
    status.pending.captureId,
  );
  try {
    record(testInfo, "capture-page", JSON.stringify(pending?.capture.page));
    expect(pending?.capture.page.service).toEqual({
      kind: "service",
      serviceId: svc("a").serviceId,
    });
    expect(JSON.stringify(pending?.capture.page)).not.toContain(origin("a"));
  } finally {
    await preview("discardPendingCapture", status.pending.captureId);
  }
});

test("a crashed service renderer reports the failure and recovers on reload", async () => {
  await onServiceContents("a", "crash");
  await expect.poll(() => onServiceContents<boolean>("a", "isCrashed")).toBe(true);
  await expect(
    s().window.getByRole("alert").filter({ hasText: "Preview renderer stopped" }),
  ).toBeVisible({ timeout: 20_000 });
  await s().window.getByRole("button", { name: "Reload preview" }).first().click();
  await expect.poll(() => onServiceContents<boolean>("a", "isCrashed")).toBe(false);
  await waitForService("a", "/app/next");
  const [view] = await viewsOn(origin("a"));
  expect(view?.visible).toBe(true);
});

test("repeated open, hide and close keeps resource counts stable and releases everything", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const fixture = fixtureOf("a");
  const baseline = {
    webContents: await webContentsCount(),
    access: await accessStats(),
  };
  for (let cycle = 0; cycle < 8; cycle += 1) {
    const tabId = `cycle-${cycle}`;
    await attachService("a", tabId, true);
    await expect.poll(async () => (await viewsOn(origin("a"))).length).toBe(2);
    await preview("setVisible", tabId, false);
    await preview("setVisible", tabId, true);
    await preview("destroy", tabId);
  }
  await expect.poll(async () => (await viewsOn(origin("a"))).length).toBe(1);
  const after = {
    webContents: await webContentsCount(),
    access: await accessStats(),
    sockets: fixture.openSockets(),
  };
  record(testInfo, "resource-counts", JSON.stringify({ baseline, after }));
  await expect.poll(webContentsCount).toBe(baseline.webContents);
  // The tab hold shares one attachment per service; cycles never add one.
  expect(after.access.attachments).toBe(baseline.access.attachments);
  // Pooled upstreams are bounded (`poolMax` 6) and idle out.
  await expect.poll(() => fixture.openSockets(), { timeout: 15_000 }).toBeLessThanOrEqual(6);

  // Closing every holder releases the attachments after the retirement lease.
  await uiStore("selectProject", null);
  await preview("destroy", UI_TABS.a).catch(() => undefined);
  await preview("destroy", UI_TABS.b).catch(() => undefined);
  await expect.poll(async () => (await viewsOn(origin("a"))).length).toBe(0);
  await expect
    .poll(async () => (await accessStats()).attachments, { timeout: 60_000, intervals: [2_000] })
    .toBe(0);
  await expect.poll(() => fixture.openSockets(), { timeout: 15_000 }).toBe(0);
  await expect
    .poll(() =>
      rawIngress(origin("a")).then(
        () => "listening",
        () => "closed",
      ),
    )
    .toBe("closed");
  record(
    testInfo,
    "released",
    JSON.stringify({ access: await accessStats(), webContents: await webContentsCount() }),
  );
});

// ---------------------------------------------------------------------------
// Clipboard, overlays, keyboard, narrow viewport, HMR and a second backend.

/**
 * The Edit menu's copy or paste on a service's focused view. The menu must
 * carry the role with its accelerator; the action is the web-contents method
 * the role performs. (On macOS AppKit routes the role to the OS first
 * responder, which a test on a shared desktop cannot own, so clicking the
 * item programmatically does nothing there.)
 */
async function editMenuRole(name: Name, role: "copy" | "paste"): Promise<void> {
  await s().app.evaluate(
    ({ Menu, webContents }, { viewOrigin, role }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin));
      if (!contents) throw new Error("Service preview web contents not found");
      const item = (Menu.getApplicationMenu()?.items ?? [])
        .flatMap((top) => top.submenu?.items ?? [])
        .find((candidate) => candidate.role?.toLowerCase() === role);
      if (!item) throw new Error(`The application menu has no ${role} item`);
      contents.focus();
      contents[role]();
    },
    { viewOrigin: origin(name), role },
  );
}

function hostClipboardText(): Promise<string> {
  return s().app.evaluate(({ clipboard }) => clipboard.readText());
}

/** What has keyboard focus in the main renderer. */
function focused(page = s().window) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      label: element?.getAttribute("aria-label") ?? null,
      text: (element?.textContent ?? "").trim().slice(0, 80),
      expanded: element?.getAttribute("aria-expanded") ?? null,
      inDialog: Boolean(element?.closest('[role="dialog"]')),
      inMenu: Boolean(element?.closest('[role="menu"]')),
      body: element === document.body,
      pageFocused: document.hasFocus(),
    };
  });
}

/** The locator's box lies inside the renderer's viewport (CSS pixels). */
async function expectInViewport(
  locator: ReturnType<Page["getByRole"]>,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = await s().window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  record(testInfo, `viewport-${label}`, JSON.stringify({ box, viewport }));
  expect(box, `${label} has no box`).not.toBeNull();
  expect(box!.x, label).toBeGreaterThanOrEqual(-0.5);
  expect(box!.y, label).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width, label).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box!.y + box!.height, label).toBeLessThanOrEqual(viewport.height + 0.5);
}

/**
 * Give the app's own web contents native keyboard focus, as a click in the
 * app would. Earlier steps focus a preview view natively, and Playwright's
 * clicks and key presses never move native focus back.
 */
async function focusApp(): Promise<void> {
  await s().app.evaluate(
    ({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.webContents.focus(),
    s().windowId,
  );
  // Keyboard only: a pointer left over a menu would move focus with
  // Chromium's synthetic hover events as the menu opens beneath it.
  await s().window.mouse.move(1, 1);
}

/** Open the visible tab's service picker from the keyboard and choose the item matching `item`. */
async function chooseFromPicker(current: string, item: RegExp): Promise<void> {
  const page = s().window;
  await focusApp();
  await page.getByRole("button", { name: `Preview service ${current}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  // Radix moves focus to the first item once the menu has opened.
  await expect.poll(async () => (await focused()).inMenu).toBe(true);
  const trail: string[] = [];
  for (const key of ["ArrowDown", "ArrowUp"]) {
    for (let step = 0; step < 6; step += 1) {
      const now = await focused();
      trail.push(`${now.text.slice(0, 12)}${now.pageFocused ? "" : " (page unfocused)"}`);
      if (item.test(now.text)) break;
      await page.keyboard.press(key);
      // Radix moves focus to the next item in a timer; wait for it to land
      // (at either end of the menu it stays put).
      await expect
        .poll(async () => (await focused()).text, { timeout: 2_000 })
        .not.toBe(now.text)
        .catch(() => undefined);
    }
    if (item.test((await focused()).text)) break;
  }
  const chosen = await focused();
  const items = await page.getByRole("menuitem").allInnerTexts();
  expect(chosen.inMenu && item.test(chosen.text), JSON.stringify({ chosen, trail, items })).toBe(
    true,
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("Edit-menu copy and paste reach a service view, and page clipboard access stays gated", async () => {
  const testInfo = test.info();
  const tabId = "clipboard-a";
  await attachService("a", tabId);
  await waitForService("a");
  // The host clipboard is restored afterwards. Its contents stay in main and
  // are never read into the test.
  await s().app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read().catch(() => []);
    const saved: Array<Record<string, Blob>> = [];
    for (const item of items) {
      const entry: Record<string, Blob> = {};
      for (const type of item.types) {
        const value = await item.getType(type).catch(() => null);
        if (value instanceof Blob) entry[type] = value;
      }
      if (Object.keys(entry).length > 0) saved.push(entry);
    }
    (globalThis as Record<string, unknown>).__servicePreviewClipboard = saved;
  });
  try {
    await inService(
      "a",
      `(() => {
        document.body.insertAdjacentHTML("beforeend",
          '<textarea id="paste-target"></textarea>' +
          '<button id="write-button" style="position:fixed;left:20px;top:200px;width:200px;height:60px">write</button>');
        document.querySelector("#write-button").addEventListener("click", () => {
          navigator.clipboard.writeText("written-by-svc-a").then(
            () => { window.__write = "ok"; },
            (error) => { window.__write = "denied:" + error.name; },
          );
        });
        return true;
      })()`,
    );

    // Copy: the page's selection reaches the host clipboard through the Edit menu role.
    await inService("a", `getSelection().selectAllChildren(document.querySelector("h1")); true`);
    await editMenuRole("a", "copy");
    await expect.poll(hostClipboardText).toBe("svc-a");

    // Paste: host clipboard text reaches the focused field.
    await s().app.evaluate(({ clipboard }) => clipboard.writeText("pasted-into-svc-a"));
    await inService("a", `document.querySelector("#paste-target").focus(); true`);
    await editMenuRole("a", "paste");
    await expect
      .poll(() => inService<string>("a", `document.querySelector("#paste-target").value`))
      .toBe("pasted-into-svc-a");

    // The page may never read the clipboard, and may write only right after
    // a real input event in the visible view (a script "gesture" is not one).
    const read = await inService<string>(
      "a",
      `navigator.clipboard.readText().then((text) => "read:" + text.length, (error) => "denied:" + error.name)`,
    );
    const scripted = await inService<string>(
      "a",
      `navigator.clipboard.writeText("scripted-svc-a").then(() => "ok", (error) => "denied:" + error.name)`,
    );
    record(testInfo, "page-clipboard", JSON.stringify({ read, scripted }));
    expect(read).toMatch(/^denied:/);
    expect(scripted).toMatch(/^denied:/);
    expect(await hostClipboardText()).toBe("pasted-into-svc-a");

    await s().app.evaluate(
      async ({ BrowserWindow, webContents }, { viewOrigin, windowId }) => {
        const contents = webContents
          .getAllWebContents()
          .find(
            (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin),
          );
        if (!contents) throw new Error("Service preview web contents not found");
        BrowserWindow.fromId(windowId)?.focus();
        contents.focus();
        const point = { x: 120, y: 230 };
        contents.sendInputEvent({ type: "mouseMove", ...point });
        await new Promise((resolve) => setTimeout(resolve, 60));
        contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      },
      { viewOrigin: origin("a"), windowId: s().windowId },
    );
    await expect
      .poll(() => inService<string | null>("a", `window.__write ?? null`), { timeout: 10_000 })
      .toBe("ok");
    expect(await hostClipboardText()).toBe("written-by-svc-a");
  } finally {
    await s().app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = (globalThis as Record<string, unknown>).__servicePreviewClipboard as
        | Array<Record<string, Blob>>
        | undefined;
      delete (globalThis as Record<string, unknown>).__servicePreviewClipboard;
      if (saved && saved.length > 0) {
        await clipboard.write(saved.map((entry) => new ClipboardItem(entry)));
      } else {
        await clipboard.writeText("");
      }
    });
    await preview("destroy", tabId);
  }
});

test("menus, the service dialog and the project search hide the service view and keep the page", async () => {
  const page = s().window;
  await showServiceTabs("a");
  await expectVisibility("a", [true]);
  await waitForService("a", null);
  await inService("a", `window.__overlayKept = "svc-a"; true`);
  const fixture = fixtureOf("a");
  const pageLoads = () => fixture.requests.filter((entry) => entry.path === "/").length;
  const loadsBefore = pageLoads();

  const overlays: Array<{ label: string; open: () => Promise<void> }> = [
    {
      label: "service picker menu",
      open: () => page.getByRole("button", { name: "Preview service svc-a" }).click(),
    },
    {
      label: "preview options menu",
      open: () => page.getByRole("button", { name: "Preview options" }).click(),
    },
    {
      label: "register service dialog",
      open: async () => {
        await page.getByRole("button", { name: "Preview service svc-a" }).click();
        await page.getByRole("menuitem", { name: /Register a service/ }).click();
        await expect(page.getByRole("dialog", { name: "Register preview service" })).toBeVisible();
      },
    },
    {
      label: "project search",
      open: () => page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K"),
    },
  ];
  for (const overlay of overlays) {
    await overlay.open();
    await expect(
      page.locator('[role="dialog"]:visible, [role="menu"]:visible').first(),
      overlay.label,
    ).toBeVisible();
    // Native views draw above the renderer, so any open overlay must hide them.
    await expect
      .poll(async () => (await viewsOn(origin("a"))).map((view) => view.visible), {
        message: `${overlay.label} left the view visible`,
      })
      .toEqual([false]);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]:visible, [role="menu"]:visible')).toHaveCount(0);
    await expectVisibility("a", [true]);
  }
  expect(await inService<string>("a", "window.__overlayKept")).toBe("svc-a");
  expect(pageLoads()).toBe(loadsBefore);
});

test("the picker, service dialog, diagnostics and Cmd/Ctrl+L work from the keyboard", async () => {
  const testInfo = test.info();
  const page = s().window;
  await showServiceTabs("a");
  await expectVisibility("a", [true]);
  const address = page.getByRole("textbox", { name: "Browser address" }).first();
  await focusApp();

  // Picker: open with Enter, move with arrows, choose with Enter; Escape returns focus.
  await chooseFromPicker("svc-a", /^svc-b/);
  await expect(address).toHaveValue(`http://localhost:${fixtureOf("b").port}/`);
  await expect.poll(async () => (await visibility("b")).includes(true)).toBe(true);
  await chooseFromPicker("svc-b", /^svc-a/);
  await expect(address).toHaveValue(`http://localhost:${fixtureOf("a").port}/`);
  await expectVisibility("a", [true]);
  await page.getByRole("button", { name: "Preview service svc-a" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect((await focused()).label).toBe("Preview service svc-a");

  // Service dialog: reached from the picker, focus stays inside while tabbing,
  // and Escape closes it without registering anything.
  const servicesBefore = await invoke<{ services: unknown[] }>("get_preview_services", {
    environmentId: s().environmentId,
  });
  await chooseFromPicker("svc-a", /^Register a service/);
  const dialog = page.getByRole("dialog", { name: "Register preview service" });
  await expect(dialog)
    .toBeVisible()
    .catch(async (error: Error) => {
      const state = await page.evaluate(() => ({
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(
          (element) => element.getAttribute("aria-label") ?? element.getAttribute("data-state"),
        ),
        address: (document.querySelector('[aria-label="Browser address"]') as HTMLInputElement)
          ?.value,
      }));
      throw new Error(`${error.message}\n${JSON.stringify({ state, focus: await focused() })}`);
    });
  expect((await focused()).inDialog).toBe(true);
  await page.keyboard.type("keyboard-only");
  const trail: string[] = [];
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press(step < 10 ? "Tab" : "Shift+Tab");
    const now = await focused();
    trail.push(now.label ?? now.text);
    expect(now.inDialog, `focus left the dialog after ${trail.join(" > ")}`).toBe(true);
  }
  record(testInfo, "dialog-tab-order", JSON.stringify(trail));
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expectVisibility("a", [true]);
  record(testInfo, "focus-after-dialog", JSON.stringify(await focused()));
  const servicesAfter = await invoke<{ services: unknown[] }>("get_preview_services", {
    environmentId: s().environmentId,
  });
  expect(servicesAfter.services.length).toBe(servicesBefore.services.length);

  // Diagnostics: the route toggle expands and collapses from the keyboard and
  // keeps focus, and the view stays on its (shorter) host.
  await page.getByRole("button", { name: "Route details" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("readiness", { exact: true })).toBeVisible();
  const expanded = await focused();
  record(testInfo, "focus-after-expand", JSON.stringify(expanded));
  expect(expanded.expanded).toBe("true");
  await expectViewOnHost("a", UI_TABS.a, testInfo, "diagnostics-expanded");
  await page.keyboard.press("Space");
  await expect(page.getByText("readiness", { exact: true })).toHaveCount(0);
  expect((await focused()).expanded).toBe("false");
  await expectViewOnHost("a", UI_TABS.a, testInfo, "diagnostics-collapsed");

  // Cmd/Ctrl+L from the app and from inside the native view focuses and
  // selects the address (main intercepts it in the view).
  await focusApp();
  await page.locator("body").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+L" : "Control+L");
  expect((await focused()).label).toBe("Browser address");
  await page.locator("body").focus();
  await s().app.evaluate(
    ({ webContents }, { viewOrigin, mac }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(viewOrigin));
      if (!contents) throw new Error("Service preview web contents not found");
      contents.focus();
      const modifiers: Array<"meta" | "control"> = [mac ? "meta" : "control"];
      contents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers });
    },
    { viewOrigin: origin("a"), mac: process.platform === "darwin" },
  );
  await expect.poll(async () => (await focused()).label).toBe("Browser address");
  expect(
    await page.evaluate(() => {
      const input = document.activeElement as HTMLInputElement;
      return input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }),
  ).toBe(true);
  await page.keyboard.press("Escape");
});

test("the narrowest window keeps the picker, service dialog and diagnostics usable at 100 and 150 % zoom", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const page = s().window;
  await showServiceTabs("a");
  await expectVisibility("a", [true]);
  const host = await s().app.browserWindow(page);
  const original = await host.evaluate((window) => ({
    size: window.getSize(),
    minimum: window.getMinimumSize(),
  }));
  record(testInfo, "window", JSON.stringify(original));
  // The window's own minimum is the narrowest a user can make it.
  await host.evaluate((window) => {
    const [width, height] = window.getMinimumSize();
    window.setSize(width!, height!);
  });
  try {
    for (const level of [100, 150]) {
      await uiStore("setZoomLevel", level);
      try {
        const label = `zoom-${level}`;
        const trigger = page.getByRole("button", { name: "Preview service svc-a" });
        await expect(trigger, label).toBeVisible({ timeout: 20_000 });
        await expectInViewport(trigger, testInfo, `${label}-picker-trigger`);
        await expectInViewport(
          page.getByRole("textbox", { name: "Browser address" }).first(),
          testInfo,
          `${label}-address`,
        );
        await expectViewOnHost("a", UI_TABS.a, testInfo, label);
        const window = await host.evaluate((window) => window.getContentBounds());
        const [view] = await viewsOn(origin("a"));
        expect(view!.bounds.x + view!.bounds.width).toBeLessThanOrEqual(window.width + 1);
        expect(view!.bounds.y + view!.bounds.height).toBeLessThanOrEqual(window.height + 1);

        await trigger.click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await expectInViewport(menu, testInfo, `${label}-picker-menu`);
        await expect(page.getByRole("menuitem", { name: /^svc-b/ })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);

        await page.getByRole("button", { name: "Preview options" }).click();
        await page.getByRole("menuitem", { name: /Edit service/ }).click();
        const dialog = page.getByRole("dialog", { name: "Edit preview service" });
        await expect(dialog).toBeVisible();
        await expectInViewport(dialog, testInfo, `${label}-dialog`);
        const cancel = dialog.getByRole("button", { name: "Cancel" });
        await cancel.scrollIntoViewIfNeeded();
        await expectInViewport(cancel, testInfo, `${label}-dialog-cancel`);
        await cancel.click();
        await expect(dialog).toHaveCount(0);

        await page.getByRole("button", { name: "Route details" }).click();
        await expect(page.getByText("readiness", { exact: true })).toBeVisible();
        await expectViewOnHost("a", UI_TABS.a, testInfo, `${label}-diagnostics`);
        await page.getByRole("button", { name: "Route", exact: true }).click();
        await expect(page.getByText("readiness", { exact: true })).toHaveCount(0);
        await expectVisibility("a", [true]);
      } finally {
        if (level !== 100) await uiStore("setZoomLevel", 100).catch(() => undefined);
      }
    }
  } finally {
    await host.evaluate((window, size) => window.setSize(size[0]!, size[1]!), original.size);
  }
});

/** A Vite application from the checked-in fixture, in its own temporary directory. */
async function startViteApp(upgradeLog: string): Promise<ViteApp> {
  const fixtureRoot = path.join(repositoryRoot, "test-fixtures", "preview-vite");
  const root = await realpath(await mkdtemp(path.join(s().temporaryRoot, "preview-vite-")));
  await cp(path.join(fixtureRoot, "index.html"), path.join(root, "index.html"));
  await cp(path.join(fixtureRoot, "src"), path.join(root, "src"), { recursive: true });
  // Records each upgrade Vite receives. Through the tunnel its Host is the
  // private authority; Vite's direct fallback socket would show 127.0.0.1.
  await writeFile(
    path.join(root, "vite.config.mjs"),
    `import { appendFileSync } from "node:fs";
export default {
  plugins: [{
    name: "record-upgrades",
    configureServer(server) {
      server.httpServer?.on("upgrade", (request) => {
        appendFileSync(${JSON.stringify(upgradeLog)}, JSON.stringify({
          host: request.headers.host ?? null,
          protocol: request.headers["sec-websocket-protocol"] ?? null,
          ingressHeader: ${JSON.stringify(PREVIEW_INGRESS_HEADER)} in request.headers,
        }) + "\\n");
      });
    },
  }],
};
`,
  );
  // The pinned fixture install when given (testing-guide.md), else the repository's Vite.
  const pinned = process.env.ORKESTRATOR_TEST_PREVIEW_VITE_DIR;
  const viteBin = pinned
    ? path.join(pinned, "node_modules", "vite", "bin", "vite.js")
    : path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
  const [port] = (await reserveLoopbackPorts(1)) as [number];
  const child = ownProcessGroup(
    spawn(
      process.execPath,
      [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: root, detached: true, stdio: "ignore" },
    ),
  );
  const app = { process: child, root, port };
  s().viteApp = app;
  await waitForUrl(`http://127.0.0.1:${port}/`);
  return app;
}

function viteState() {
  return inService<{ text: string | null; updates: string | null; kept: string | null }>(
    "v",
    `({ text: document.querySelector("#app")?.textContent ?? null, updates: document.body?.dataset.hmrUpdates ?? null, kept: window.__viteKept ?? null })`,
  ).catch((error: Error) => ({ text: error.message, updates: null, kept: null }));
}

test("a Vite app keeps HMR updates made while its tab is hidden, unmounted or reloaded", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  const upgradeLog = path.join(s().temporaryRoot, "vite-upgrades.log");
  const vite = await startViteApp(upgradeLog);
  try {
    s().services.v = await registerService(
      invoke,
      {
        marker: "preview-vite",
        fixture: null,
        port: vite.port,
        environmentId: s().environmentId,
        backendInstanceId: s().backendInstanceId,
      },
      "/",
    );
    const label = path.join(vite.root, "src", "label.js");
    const writeLabel = (version: string) =>
      writeFile(label, `export const label = "preview-vite ${version}";\n`);
    const upgrades = async () =>
      (await readFile(upgradeLog, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { host: string; protocol: string | null; ingressHeader: boolean },
        );

    await showServiceTabs("v", ["a", "v"]);
    await expectVisibility("v", [true]);
    await expect
      .poll(async () => (await viteState()).text, { timeout: 30_000 })
      .toBe("preview-vite v1");
    await expect
      .poll(async () => (await upgrades()).some((entry) => entry.protocol === "vite-hmr"), {
        timeout: 30_000,
      })
      .toBe(true);
    await inService("v", `window.__viteKept = "kept"; true`);
    // Each write is applied in place: the text changes, the page is the same
    // document, and the accept handler ran again (a write can raise more than
    // one watcher change, so the count only has to grow).
    let applied = 0;
    const expectApplied = async (text: string) => {
      let last = await viteState();
      await expect
        .poll(
          async () => {
            last = await viteState();
            return (
              last.text === `preview-vite ${text}` &&
              last.kept === "kept" &&
              Number(last.updates ?? 0) > applied
            );
          },
          { timeout: 30_000, message: `HMR ${text} not applied in place` },
        )
        .toBe(true)
        .catch((error: Error) => {
          throw new Error(`${error.message}\n${JSON.stringify(last)}`);
        });
      applied = Number(last.updates);
      record(testInfo, `hmr-${text}`, JSON.stringify(last));
    };

    // Hidden: another tab is active while the module changes.
    await uiTab("a").click();
    await expectVisibility("v", [false]);
    await writeLabel("v2");
    await expectApplied("v2");
    await uiTab("v").click();
    await expectVisibility("v", [true]);
    expect(await viteState()).toMatchObject({ text: "preview-vite v2", kept: "kept" });

    // Unmounted: no environment is shown while the module changes.
    await uiStore("selectProject", null);
    await expectVisibility("v", [false]);
    await writeLabel("v3");
    await expectApplied("v3");
    await uiStore("selectProjectAndEnvironment", s().projectId, s().environmentId);
    await closeStartupDialogs();
    await expectVisibility("v", [true]);
    expect(await viteState()).toMatchObject({ text: "preview-vite v3", kept: "kept" });

    // A renderer reload while the update is in flight.
    await writeLabel("v4");
    await s().window.reload();
    await waitForApi(s().window);
    await uiStore("selectProjectAndEnvironment", s().projectId, s().environmentId);
    await closeStartupDialogs();
    await expectVisibility("v", [true]);
    await expectApplied("v4");

    const seen = await upgrades();
    record(testInfo, "vite-upgrades", JSON.stringify(seen));
    // Every HMR socket crossed the tunnel: private authority, no ingress credential.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((entry) => entry.host !== `localhost:${vite.port}`)).toEqual([]);
    expect(seen.filter((entry) => entry.ingressHeader)).toEqual([]);
  } finally {
    await stopProcessGroup(vite.process).catch(() => undefined);
    s().viteApp = null;
  }
});

/** Call `run` with `values` in `process.env`, restored as soon as it returns. */
function withEnvironment<T>(values: Record<string, string>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A second, disposable backend (agent-test isolation), as a remote connection would reach it. */
async function startRemoteBackend(validateCapabilities?: () => void): Promise<RemoteBackend> {
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const root = path.join(s().temporaryRoot, "remote");
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "service-preview-remote",
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    },
  });
  await initializeProfile(profile);
  const backendProcess = new BackendProcess();
  s().remoteProcess = backendProcess;
  try {
    // The backend's environment is built synchronously when it spawns.
    await withEnvironment(
      { ORKESTRATOR_PREVIEW_TRANSPORT: "1", ORKESTRATOR_CONTROL_MCP_PORT: "0" },
      () =>
        backendProcess.start({
          isDev: true,
          appRoot: repositoryRoot,
          resourceRoot: repositoryRoot,
          dataDir: profile.dataDir,
          gatewayHost: "127.0.0.1",
          gatewayPort,
          allowNonTailscaleBind: true,
          runtimeFlavor: "agent-test",
          runtimeProfileId: profile.id,
          worktreeDir: profile.worktreeDir,
          strictGatewayPort: true,
          strictDockerOwner: true,
          onEvent: () => undefined,
        }),
    );
    const info = backendProcess.getInfo();
    if (!info) throw new Error("The remote backend reported no gateway");
    const token = (JSON.parse(await readFile(info.authFile, "utf8")) as { token: string }).token;
    const address = `http://127.0.0.1:${gatewayPort}`;
    const client = new BackendHttpClient(address, token);
    const capabilities = await client.invoke<{
      backendInstanceId: string;
      surfaces: { desktopTunnel: { available: boolean } };
    }>("get_preview_capabilities");
    expect(capabilities.surfaces.desktopTunnel.available).toBe(true);
    expect(capabilities.backendInstanceId).not.toBe(s().backendInstanceId);
    validateCapabilities?.();
    const remote = {
      process: backendProcess,
      address,
      token,
      backendInstanceId: capabilities.backendInstanceId,
    };
    s().remote = remote;

    const projectPath = await prepareFixtureRepository(profile, templateRoot);
    const project = await client.invoke<{ id: string }>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const environment = await client.invoke<{ id: string }>("create_environment", {
      projectId: project.id,
      name: "service-preview-remote-fixture",
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await client.invoke("start_environment", { environmentId: environment.id });
    const fixture = await startPreviewFixture({ marker: "svc-remote" });
    s().services.r = { marker: "svc-remote", fixture, port: fixture.port } as Service;
    s().services.r = await registerService((command, args) => client.invoke(command, args), {
      marker: "svc-remote",
      fixture,
      port: fixture.port,
      environmentId: environment.id,
      backendInstanceId: capabilities.backendInstanceId,
    });
    return remote;
  } catch (error) {
    // Stop before any profile cleanup, even if auth/capability setup failed
    // before a complete RemoteBackend could be published.
    await backendProcess.stop();
    throw error;
  }
}

test("failed remote capability setup stops its backend before profile cleanup", async () => {
  let pid: number | undefined;
  let address = "";
  await expect(
    startRemoteBackend(() => {
      const backend = s().remoteProcess!;
      pid = backend.getPid();
      address = `http://127.0.0.1:${backend.getInfo()!.port}`;
      throw new Error("forced remote capability failure");
    }),
  ).rejects.toThrow("forced remote capability failure");
  expect(pid).toBeDefined();
  expect(() => process.kill(pid!, 0)).toThrow();
  await expect(rawIngress(address)).rejects.toThrow();
  expect(s().remoteProcess!.getInfo()).toBeNull();
  // The backend has exited while its profile is still present.
  expect(await realpath(path.join(s().temporaryRoot, "remote"))).toBeTruthy();
});

function remoteAttachments(): Promise<number> {
  const remote = s().remote!;
  return new BackendHttpClient(remote.address, remote.token)
    .invoke<{ access: { attachments: number } }>("get_preview_diagnostics")
    .then((diagnostics) => diagnostics.access.attachments);
}

function useConnection(page: Page, connectionId: string): Promise<unknown> {
  return page.evaluate((id) => (globalThis as any).orkestrator.connections.use(id), connectionId);
}

test("windows on different backends never share previews, and switches release on the issuing backend", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(300_000);
  const remote = await startRemoteBackend();
  // Only this test's own views from here on.
  await uiStore("selectProject", null);
  for (const tabId of Object.values(UI_TABS))
    await preview("destroy", tabId).catch(() => undefined);
  await attachService("a", "multi-a");
  await waitForService("a");
  await inService("a", `window.__multiKept = "svc-a"; true`);
  const localBaseline = (await accessStats()).attachments;

  // A second window, first on Local with a service of its own.
  const [second] = await Promise.all([
    s().app.waitForEvent("window", {
      predicate: (candidate) => candidate.url().startsWith(s().rendererUrl),
      timeout: 60_000,
    }),
    s().window.evaluate(() => (globalThis as any).orkestrator.connections.openWindow("local")),
  ]);
  await waitForApi(second);
  const secondId = await (await s().app.browserWindow(second)).evaluate((window) => window.id);
  await attachService("b", "multi-b", true, second);
  await expect.poll(async () => (await viewsOn(origin("b"), secondId)).length).toBe(1);
  await expect.poll(async () => (await accessStats()).attachments).toBe(localBaseline + 1);

  // Adding a connection switches the window that asked: its Local previews end.
  // The token is the disposable backend's own.
  const remoteId = await second.evaluate(
    async (input) =>
      (await (globalThis as any).orkestrator.connections.connect({ ...input, nickname: "Remote" }))
        .activeConnectionId as string,
    { address: remote.address, token: remote.token },
  );
  expect(remoteId).not.toBe(LOCAL_CONNECTION_ID);
  await expect.poll(async () => (await viewsOn(origin("b"), secondId)).length).toBe(0);
  await expect
    .poll(async () => (await accessStats()).attachments, { timeout: 20_000 })
    .toBe(localBaseline);

  // Window 2's service comes from the second backend, in that connection's partition.
  const remoteState = await attachService("r", "multi-r", true, second);
  expect(remoteState.transport).toEqual({ mode: "desktop-tunnel", state: "ready" });
  await waitForService("r");
  const [viewR] = await viewsOn(origin("r"), secondId);
  const [viewA] = await viewsOn(origin("a"));
  const partitionName = (slot: number, connectionId: string, name: Name) =>
    browserPreviewServicePartition(slot, connectionId, svc(name)).slice("persist:".length);
  record(testInfo, "partitions", JSON.stringify({ r: viewR?.storagePath, a: viewA?.storagePath }));
  expect(viewR!.storagePath).toContain(partitionName(2, remoteId, "r"));
  expect(viewA!.storagePath).toContain(partitionName(1, LOCAL_CONNECTION_ID, "a"));
  const remoteFixture = fixtureOf("r");
  const remotePage = remoteFixture.requests.find((entry) => entry.path === "/");
  expect(remotePage?.host).toBe(`localhost:${remoteFixture.port}`);
  expect(remotePage?.headerNames).not.toContain(PREVIEW_INGRESS_HEADER);
  expect(await remoteAttachments()).toBe(1);
  expect((await accessStats()).attachments).toBe(localBaseline);

  // Nothing crosses between the two windows' services.
  await inService(
    "r",
    `document.cookie = "iso=svc-remote; path=/"; localStorage.setItem("iso", "svc-remote"); true`,
  );
  const seenFromA = await inService<{ cookie: string; local: string | null }>(
    "a",
    `({ cookie: document.cookie, local: localStorage.getItem("iso") })`,
  );
  const seenFromR = await inService<{ cookie: string; local: string | null }>(
    "r",
    `({ cookie: document.cookie, local: localStorage.getItem("iso") })`,
  );
  record(testInfo, "cross-window", JSON.stringify({ seenFromA, seenFromR }));
  expect(seenFromA.cookie).not.toContain("svc-remote");
  expect(seenFromA.local).not.toBe("svc-remote");
  expect(seenFromR).toEqual({ cookie: "iso=svc-remote", local: "svc-remote" });

  // Window 1 (Local) cannot open the second backend's service.
  const remoteRequests = remoteFixture.requests.length;
  const crossed = await preview<BrowserPreviewState>("attach", {
    tabId: "multi-crossed",
    service: serviceTarget("r"),
    bounds: BOUNDS,
    visible: true,
  }).catch((error: Error) => ({ error: error.message }));
  let crossedState: unknown = crossed;
  await expect
    .poll(
      async () => {
        // A refused attach leaves no tab to ask; keep its rejection.
        crossedState =
          (await preview<BrowserPreviewState | null>("setVisible", "multi-crossed", true).catch(
            (error: Error) => ({ error: error.message }),
          )) ?? crossedState;
        const state = crossedState as (Partial<BrowserPreviewState> & { error?: string }) | null;
        return Boolean(state?.error || state?.transport?.state === "unavailable");
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  record(testInfo, "cross-backend-attach", JSON.stringify(crossedState));
  await preview("destroy", "multi-crossed").catch(() => undefined);
  expect(remoteFixture.requests.length).toBe(remoteRequests);
  expect(await remoteAttachments()).toBe(1);

  // Switching window 2 back to Local ends its remote previews and releases the
  // attachment on the backend that issued it.
  const remoteIngress = origin("r");
  await useConnection(second, LOCAL_CONNECTION_ID);
  await expect.poll(async () => (await viewsOn(remoteIngress, secondId)).length).toBe(0);
  await expect.poll(remoteAttachments, { timeout: 20_000 }).toBe(0);
  await expect
    .poll(() =>
      rawIngress(remoteIngress).then(
        () => "listening",
        () => "closed",
      ),
    )
    .toBe("closed");
  await expect.poll(() => remoteFixture.openSockets(), { timeout: 15_000 }).toBe(0);
  // Window 1 never noticed.
  expect(await inService<string>("a", "window.__multiKept")).toBe("svc-a");
  expect((await accessStats()).attachments).toBe(localBaseline);

  // Back on the remote, the same slot and connection reuse the service's partition.
  await useConnection(second, remoteId);
  await attachService("r", "multi-r", true, second);
  await waitForService("r");
  expect(await inService<string | null>("r", `localStorage.getItem("iso")`)).toBe("svc-remote");
  expect(await remoteAttachments()).toBe(1);

  // Forget removes the active connection before preview teardown. The old
  // transport must retain its client to release on the issuing backend.
  // Seed actual native sessions, including the shared legacy partition. The
  // production forget handler must clear both, while Local remains in use.
  const retiredPartitions = [
    browserPreviewServicePartition(2, remoteId, svc("r")),
    browserPreviewPartitionForWindow(2, remoteId),
  ];
  const localPartition = browserPreviewServicePartition(1, LOCAL_CONNECTION_ID, svc("a"));
  const retiredPaths = await s().app.evaluate(
    async ({ session }, partitions) => {
      const paths: string[] = [];
      for (const partition of partitions) {
        const native = session.fromPartition(partition);
        await native.cookies.set({
          url: "https://retention.test",
          name: "retention",
          value: "seed",
        });
        await native.cookies.flushStore();
        paths.push(native.getStoragePath()!);
      }
      return paths;
    },
    [...retiredPartitions, localPartition],
  );
  const forgottenIngress = origin("r");
  const forgotten = await second.evaluate(
    (id) => (globalThis as any).orkestrator.connections.forget(id),
    remoteId,
  );
  expect(forgotten.activeConnectionId).toBe(LOCAL_CONNECTION_ID);
  expect(
    forgotten.connections.some((connection: { id: string }) => connection.id === remoteId),
  ).toBe(false);
  await expect.poll(async () => (await viewsOn(forgottenIngress, secondId)).length).toBe(0);
  await expect.poll(remoteAttachments, { timeout: 20_000 }).toBe(0);
  await expect
    .poll(() =>
      rawIngress(forgottenIngress).then(
        () => "listening",
        () => "closed",
      ),
    )
    .toBe("closed");
  await expect.poll(() => remoteFixture.openSockets(), { timeout: 15_000 }).toBe(0);
  await expect
    .poll(
      () =>
        s().app.evaluate(
          async ({ session }, partitions) =>
            Promise.all(
              partitions.map(
                async (partition) =>
                  (await session.fromPartition(partition).cookies.get({ name: "retention" }))
                    .length,
              ),
            ),
          retiredPartitions,
        ),
      { timeout: 20_000 },
    )
    .toEqual([0, 0]);
  expect(
    await s().app.evaluate(
      async ({ session }, partition) =>
        (await session.fromPartition(partition).cookies.get({ name: "retention" })).length,
      localPartition,
    ),
  ).toBe(1);
  await attachService("b", "after-forget-local", true, second);
  await waitForService("b");
  const [localAfterForget] = await viewsOn(origin("b"), secondId);
  expect(localAfterForget!.storagePath).toContain(partitionName(2, LOCAL_CONNECTION_ID, "b"));
  expect(localAfterForget!.storagePath).not.toContain(partitionName(2, remoteId, "r"));
  expect(await inService<string>("a", "window.__multiKept")).toBe("svc-a");

  // Reconnect for the independent window-close path.
  await second.evaluate(
    (input) =>
      (globalThis as any).orkestrator.connections.connect({ ...input, nickname: "Remote again" }),
    { address: remote.address, token: remote.token },
  );
  await attachService("r", "multi-r-close", true, second);
  await waitForService("r");
  expect(await remoteAttachments()).toBe(1);
  await expect.poll(async () => (await accessStats()).attachments).toBe(localBaseline);

  // Closing the window releases on its backend too.
  const closeStarted = Date.now();
  await s().app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), secondId);
  await expect
    .poll(() => s().app.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id), secondId), {
      timeout: 30_000,
      message: "window 2 did not close",
    })
    .toBe(true);
  const closedAfter = Date.now() - closeStarted;
  await expect
    .poll(remoteAttachments, { timeout: 20_000 })
    .toBe(0)
    .catch(async (error: Error) => {
      throw new Error(
        `${error.message}\n${JSON.stringify({ closedAfterMs: closedAfter, sinceCloseMs: Date.now() - closeStarted, local: await accessStats() })}`,
      );
    });
  record(testInfo, "window-close", JSON.stringify({ closedAfterMs: closedAfter }));
  await expect
    .poll(() =>
      rawIngress(origin("r")).then(
        () => "listening",
        () => "closed",
      ),
    )
    .toBe("closed");
  expect(await inService<string>("a", "window.__multiKept")).toBe("svc-a");
  await preview("destroy", "multi-a");
  // Restart the actual main process: its startup sweep must remove the
  // directories recorded by that native clear, before creating any views.
  await closeElectron();
  const restarted = await launchElectron(s());
  Object.assign(s(), restarted);
  for (const retired of retiredPaths.slice(0, 2))
    expect(
      await stat(retired).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  expect(
    await stat(retiredPaths[2]!).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
});
