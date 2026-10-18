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
 * Covers (docs/todo/service-preview-rollout.md, "Real Electron window"):
 * credentialed ingress and header injection for HTTP and WebSocket requests,
 * including worker-originated fetches; cookie, localStorage, IndexedDB and
 * service-worker isolation between two services; hide and reattach, and a
 * renderer reload, without reloading the page; history, app zoom, DevTools,
 * screenshots and an annotation capture after reattach; a preview renderer
 * crash and reload; stable resource counts over repeated open, hide and close,
 * and full release after the retirement lease.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrowserPreviewPendingCapture,
  BrowserPreviewSelectionStatus,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { PREVIEW_ERROR_HEADER } from "@orkestrator/protocol/node/preview-forward";
import { PREVIEW_INGRESS_HEADER } from "@orkestrator/protocol/preview-access";
import { formatPreviewServiceUri } from "@orkestrator/protocol/preview-services";

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
type Name = "a" | "b";

interface Service {
  marker: string;
  fixture: PreviewFixture;
  serviceId: string;
}

interface Stack {
  temporaryRoot: string;
  profile: RuntimeProfile;
  profilePath: string;
  rendererUrl: string;
  vite: ChildProcess;
  app: ElectronApplication;
  window: Page;
  projectId: string;
  environmentId: string;
  backendInstanceId: string;
  services: Record<Name, Service>;
  /** Ingress origin per service, learned from its first attach (stable via port hints). */
  origins: Partial<Record<Name, string>>;
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
    args: [...ELECTRON_TEST_SWITCHES, path.join(packageRoot, "dist", "electron", "main.js")],
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
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
  });
  return { app, window };
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
  await app.close().catch(() => undefined);
  await expect.poll(() => children.filter(alive).length, { timeout: 20_000 }).toBe(0);
}

const invoke: Invoke = (command, args = {}) =>
  s().window.evaluate(
    ({ command, args }) => (globalThis as any).orkestrator.invoke(command, args),
    { command, args },
  );

/** The production preload preview API (`window.orkestrator.browserPreview`). */
function preview<T>(method: string, ...args: unknown[]): Promise<T> {
  return s().window.evaluate(
    ({ method, args }) => {
      const api = (globalThis as any).orkestrator.browserPreview;
      const target = method in api ? api : api.capture;
      return target[method](...args);
    },
    { method, args },
  );
}

function serviceTarget(name: Name, routePath = "/") {
  return {
    backendInstanceId: s().backendInstanceId,
    environmentId: s().environmentId,
    serviceId: s().services[name].serviceId,
    path: routePath,
  };
}

async function attachService(name: Name, tabId: string, visible = true) {
  const state = await preview<BrowserPreviewState>("attach", {
    tabId,
    service: serviceTarget(name),
    bounds: BOUNDS,
    visible,
  });
  if (!s().origins[name]) {
    // The view reports its URL once the first navigation commits.
    let current = state;
    await expect
      .poll(
        async () => {
          current =
            (await preview<BrowserPreviewState | null>("setVisible", tabId, visible)) ?? state;
          return current.url;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^http:\/\//);
    s().origins[name] = new URL(current.url).origin;
    return current;
  }
  return state;
}

/** Every native preview view on the main window whose URL is on `viewOrigin`. */
function viewsOn(viewOrigin: string): Promise<ViewInfo[]> {
  return s().app.evaluate(({ BrowserWindow }, viewOrigin) => {
    const host = BrowserWindow.getAllWindows()[0];
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
  }, viewOrigin);
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

async function waitForService(name: Name, routePath = "/"): Promise<void> {
  const marker = s().services[name].marker;
  const ready = () =>
    inService<boolean>(
      name,
      `document.readyState === "complete" && document.body?.dataset.loaded === ${JSON.stringify(marker)} && location.pathname === ${JSON.stringify(routePath)}`,
    ).catch(() => false);
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      // Enough page state to tell a wrong page, an error body and a stall apart.
      const page = await inService<unknown>(
        name,
        `({ path: location.pathname, readyState: document.readyState, loaded: document.body?.dataset.loaded ?? null, text: (document.body?.innerText ?? "").slice(0, 200) })`,
      ).catch((error: Error) => error.message);
      const requests = s().services[name].fixture.requests.map((entry) => entry.path);
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

const UI_TABS: Record<Name, string> = { a: "service-ui-tab-a", b: "service-ui-tab-b" };

/** Show the environment with one service tab per fixture, rendered by the real renderer. */
async function showServiceTabs(active: Name): Promise<void> {
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
        tabs: (["a", "b"] as const).map((name) => ({
          id: UI_TABS[name],
          type: "browser",
          browserData: { url: formatPreviewServiceUri(serviceTarget(name)) },
        })),
      },
    },
  });
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

/** The pane tab strip entry for a service tab, in layout order. */
function uiTab(name: Name) {
  return s()
    .window.getByRole("button", { name: name === "a" ? /^Browser 1 / : /^Browser 2 / })
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
        const zoom = await s().app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
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
  const partial = {
    temporaryRoot,
    profile,
    profilePath,
    rendererUrl,
    vite,
    origins: {},
  } as unknown as Stack;
  stack = partial;
  const fixtures = await Promise.all(
    (["svc-a", "svc-b"] as const).map((marker) => startPreviewFixture({ marker })),
  );
  partial.services = {
    a: { marker: "svc-a", fixture: fixtures[0]!, serviceId: "" },
    b: { marker: "svc-b", fixture: fixtures[1]!, serviceId: "" },
  };
  await waitForUrl(rendererUrl);
  const { app, window } = await launchElectron(partial);
  partial.app = app;
  partial.window = window;

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
    const service = partial.services[name];
    const created = await invoke<{ kind: string; definition?: { serviceId: string } }>(
      "register_preview_service",
      {
        service: {
          environmentId: environment.id,
          label: service.marker,
          targetKind: "worktree",
          applicationPort: service.fixture.port,
          addressFamily: "ipv4",
          readinessPath: "/health",
        },
        operationId: `register-${service.marker}`,
      },
    );
    expect(created.kind).toBe("definition");
    service.serviceId = created.definition!.serviceId;
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
  for (const service of Object.values(current.services ?? {})) {
    await service.fixture?.close().catch(() => undefined);
  }
  if (current.vite?.pid) {
    try {
      process.kill(-current.vite.pid, "SIGTERM");
    } catch {}
  }
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

  const fixture = s().services.a.fixture;
  const state = await attachService("a", "service-a");
  const ingress = new URL(state.url);
  record(testInfo, "attach-state", JSON.stringify({ ...state, url: `${ingress.origin}/` }));
  expect(ingress.hostname).toBe("127.0.0.1");
  expect(Number(ingress.port)).not.toBe(fixture.port);
  expect(state.service).toMatchObject({
    serviceId: s().services.a.serviceId,
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
  const fixture = s().services.a.fixture;
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
  const fixtureA = s().services.a.fixture;
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
  await expect(address).toHaveValue(`http://localhost:${s().services.a.fixture.port}/`);
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
    `http://localhost:${s().services.a.fixture.port}/`,
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
    `http://localhost:${s().services.a.fixture.port}/app/next`,
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
      serviceId: s().services.a.serviceId,
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
  const fixture = s().services.a.fixture;
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
