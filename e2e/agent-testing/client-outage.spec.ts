import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Response as PageResponse,
  type TestInfo,
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { BackendProcess } from "../../apps/desktop/electron/backend-process";
import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import {
  BLANK_PATH,
  retriesAreSpread,
  retryRungs,
  startOutageLink,
  type LinkRequest,
  type LinkRequestKind,
  type OutageLink,
} from "./client-outage-support";

/**
 * Client reconnect and freshness under a real outage, against a real backend:
 * a dropped link (several tabs and terminals on each transport), a stopped and
 * restarted backend, and terminal recovery under real TCP backpressure. See
 * docs/todo/transcripts-and-observation/0051-client-reconnect-and-freshness.md.
 *
 * The link is a proxy inside this test (`client-outage-support.ts`), so the
 * machine's network is untouched, and one tab per listener attributes every
 * attempt to its owner. A cookie session lapses when the backend restarts, by
 * design, so the restart cases measure the stream and terminal ladders with
 * direct (bearer) clients and use a fresh `dev:login` link for the UI.
 *
 * Run against a credential-free profile of its own; it stops and restarts that
 * profile's backend, and leaves its replacement stopped:
 *
 *   mise run dev:test --profile qa-outage --fixture --no-agent-credentials --agent-platforms codex
 *   ORKESTRATOR_AGENT_TEST_PROFILE=qa-outage ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1 \
 *     mise run test:logged -- --name client-outage -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts client-outage.spec.ts --workers=1
 */

type Status = {
  status: string;
  browserUrl?: string;
  rendererUrl?: string;
  testProject?: string;
  authFile?: string;
  pids?: { backend?: number };
};
type Project = { id: string; localPath: string | null; name: string };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Transport = "http-sse" | "websocket";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE === "1";
/** Long enough to climb the event ladder (2, 4, 8, 16 s) to its cap. */
const OUTAGE_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_OUTAGE_MS ?? 45_000);
const BANNER_DELAY_MS = 4_000;
const EVENT_RECONNECT_FIRST_MS = 2_000;
const EVENT_RECONNECT_CAP_MS = 16_000;
/** Same-origin streams come back on the browser's or the ladder's next attempt. */
const RECONNECT_BUDGET_MS = EVENT_RECONNECT_CAP_MS + 4_000;
/** Enough output to overflow the gateway's bounded queue behind a stalled socket. */
const FLOOD_LINES = Number(process.env.ORKESTRATOR_AGENT_TEST_FLOOD_LINES ?? 4_000_000);
const COMPARED_LINES = 200;
const NETWORK_RESEND_MS = 100;
const QUIET_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_QUIET_MS ?? 45_000);
/** The next retry finds the refused credential: at most one rung after a short outage. */
const LAPSE_BUDGET_MS = 20_000;
const QUICK_RESTARTS = Number(process.env.ORKESTRATOR_AGENT_TEST_QUICK_RESTARTS ?? 5);
/** Two silent keepalives and the slack (60 s), the banner's delay, and a margin. */
const SILENT_LINK_BANNER_BUDGET_MS = 75_000;

test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1 against a disposable profile");
// The durable token reaches the direct clients as a page argument.
test.use({ trace: "off", screenshot: "off", video: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

function gatewayToken(status: Status): string {
  return (JSON.parse(readFileSync(status.authFile!, "utf8")) as { token: string }).token;
}

/** Setup and checks reach the gateway directly, so no outage ever touches them. */
function directInvoke(status: Status): Invoke {
  const url = new URL("/__orkestrator/invoke", status.browserUrl!).href;
  const token = gatewayToken(status);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) throw new Error(`${command} failed with HTTP ${response.status}`);
    return ((await response.json()) as { result: T }).result;
  };
}

function mintLoginPath(): string {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const url = new URL(login.loginUrl);
  return `${url.pathname}${url.search}`;
}

/** The backend's process handle once this spec has replaced the profile's own. */
let replacementBackend: BackendProcess | null = null;

function runtimeProfile(): RuntimeProfile {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function processCommand(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops this profile's backend: the replacement it owns, or the profile's. */
async function stopBackend(status: Status): Promise<void> {
  if (replacementBackend) {
    await replacementBackend.stop();
    replacementBackend = null;
    return;
  }
  const pid = status.pids?.backend;
  if (!pid) throw new Error("dev:status reported no backend process");
  const { dataDir } = runtimeProfile();
  // PIDs are reused and production shares this host: confirm the identity.
  const command = processCommand(pid);
  if (!command.includes("apps/backend/src/main.ts") || !command.includes(dataDir)) {
    throw new Error("The recorded backend PID is not this profile's backend");
  }
  process.kill(pid, "SIGTERM");
  await expect.poll(() => isRunning(pid), { timeout: 30_000 }).toBe(false);
}

/** The activation directory the profile's own backend was given. */
async function toolchainBinDir(dataDir: string): Promise<string> {
  const binRoot = path.join(dataDir, "toolchains", "bin");
  // One directory per pinned set; the profile's platform selection is the fullest.
  const sets = await Promise.all(
    (await readdir(binRoot)).map(async (name) => ({
      directory: path.join(binRoot, name),
      tools: (await readdir(path.join(binRoot, name))).length,
    })),
  );
  return sets.sort((first, second) => second.tools - first.tools)[0]!.directory;
}

/** Same data, port and token as the backend that stopped; Electron stays as it was. */
async function startBackend(status: Status): Promise<void> {
  const runtime = runtimeProfile();
  const backend = new BackendProcess();
  const controlPort = process.env.ORKESTRATOR_CONTROL_MCP_PORT;
  process.env.ORKESTRATOR_CONTROL_MCP_PORT = "0";
  try {
    await backend.start({
      isDev: true,
      appRoot: repositoryRoot,
      resourceRoot: repositoryRoot,
      dataDir: runtime.dataDir,
      toolchainBinDir: await toolchainBinDir(runtime.dataDir),
      rendererDevServerUrl: status.rendererUrl,
      gatewayHost: runtime.gatewayHost,
      gatewayPort: Number(new URL(status.browserUrl!).port),
      allowNonTailscaleBind: true,
      desktopWebClient: false,
      runtimeFlavor: "agent-test",
      runtimeProfileId: runtime.id,
      worktreeDir: runtime.worktreeDir,
      dockerImage: runtime.dockerImage,
      strictDockerOwner: true,
      strictGatewayPort: true,
      credentialSources: [],
      onEvent: () => undefined,
    });
  } finally {
    if (controlPort === undefined) delete process.env.ORKESTRATOR_CONTROL_MCP_PORT;
    else process.env.ORKESTRATOR_CONTROL_MCP_PORT = controlPort;
  }
  replacementBackend = backend;
}

// Playwright replaces its worker after a failure, and a replacement backend ends
// with the worker that started it, so every case checks that one is listening.
test.beforeEach(async () => {
  const status = profileStatus();
  const reachable = await fetch(new URL("/__orkestrator/login", status.browserUrl!))
    .then(() => true)
    .catch(() => false);
  if (!reachable) await startBackend(status);
});

test.afterAll(async () => {
  await replacementBackend?.stop();
  replacementBackend = null;
});

type ProbeSnapshot = {
  banners: Array<{ at: number; visible: boolean }>;
  freshness: Array<{ at: number; kind: string | null }>;
  /** Terminal desync notices the transports delivered; never their bytes. */
  desyncs: number;
  disconnected: Array<{ at: number; value: boolean }>;
  readsStarted: number;
};

declare global {
  interface Window {
    outageProbe: { snapshot(): ProbeSnapshot };
  }
}

/** Content-free timing in the page: the banner, indicators and the coordinator. */
async function installProbe(context: BrowserContext, transport: Transport): Promise<void> {
  await context.addInitScript((transport: Transport) => {
    localStorage.setItem("orkestrator-terminal-transport", transport);
    const banners: ProbeSnapshot["banners"] = [];
    const freshness: ProbeSnapshot["freshness"] = [];
    const disconnected: ProbeSnapshot["disconnected"] = [];
    let desyncs = 0;
    let readsStarted = 0;
    let bannerVisible = false;

    const countDesync = (data: unknown) => {
      if (typeof data === "string" && /"desynced":true|"type":"desync"/.test(data)) desyncs += 1;
    };
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("message", (event) => countDesync((event as MessageEvent).data));
      }
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => countDesync(event.data));
      }
    };

    const observe = () => {
      const visible = document.querySelector('[data-testid="connection-status-banner"]') !== null;
      if (visible !== bannerVisible) {
        bannerVisible = visible;
        banners.push({ at: Date.now(), visible });
      }
      const kinds = Array.from(document.querySelectorAll("[data-freshness]")).map((element) =>
        element.getAttribute("data-freshness"),
      );
      const kind = kinds.length > 0 ? kinds.sort().join(",") : null;
      if ((freshness.at(-1)?.kind ?? null) !== kind) freshness.push({ at: Date.now(), kind });
    };
    const start = () => {
      new MutationObserver(observe).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-freshness"],
      });
      observe();
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });

    const sampleCoordinator = async () => {
      const modulePath = "/src/lib/read-coordinator.ts";
      try {
        const { getReadCoordinator } = await import(/* @vite-ignore */ modulePath);
        const diagnostics = getReadCoordinator().getDiagnostics();
        readsStarted = diagnostics.readsStarted;
        if (disconnected.at(-1)?.value !== diagnostics.disconnected) {
          disconnected.push({ at: Date.now(), value: diagnostics.disconnected });
        }
      } catch {
        // Not loaded yet.
      }
    };
    setInterval(() => void sampleCoordinator(), 100);

    window.outageProbe = {
      snapshot: () => ({ banners, freshness, desyncs, disconnected, readsStarted }),
    };
  }, transport);
}

type Tab = {
  page: Page;
  link: OutageLink;
  /** Ids of the terminal sessions this tab's real UI created or attached. */
  sessions: Set<string>;
};

async function createEnvironments(
  invoke: Invoke,
  fixture: Project,
  label: string,
): Promise<[Environment, Environment]> {
  const created: Environment[] = [];
  for (const [index, suffix] of ["split", "single"].entries()) {
    const environment = await invoke<Environment>("create_environment", {
      projectId: fixture.id,
      name: `${label}-${suffix}-${Date.now()}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    created.push(environment);
    await invoke("start_environment", { environmentId: environment.id });
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: environment.id,
    });
    const leaf = (name: string) => ({
      kind: "leaf",
      id: `pane-${name}`,
      activeTabId: `tab-${name}`,
      tabs: [{ id: `tab-${name}`, type: "plain" }],
    });
    await invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane-first",
        root:
          index === 0
            ? {
                kind: "split",
                id: "split-root",
                direction: "horizontal",
                sizes: [50, 50],
                depth: 1,
                children: [leaf("first"), leaf("second")],
              }
            : leaf("first"),
      },
    });
  }
  return created as [Environment, Environment];
}

async function removeEnvironments(invoke: Invoke, environments: Environment[]): Promise<void> {
  for (const environment of environments) {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
}

/** Opens one browser tab over its own link on the real app, and its environment. */
async function openTab(
  context: BrowserContext,
  options: {
    owner: string;
    status: Status;
    projectName: string;
    environmentName: string;
    terminals: number;
  },
): Promise<Tab> {
  const link = await startOutageLink({
    owner: options.owner,
    gatewayUrl: options.status.browserUrl!,
    rendererUrl: options.status.rendererUrl!,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const sessions = new Set<string>();
  page.on("response", (response: PageResponse) => {
    if (!response.url().endsWith("/__orkestrator/invoke") || !response.ok()) return;
    const request = response.request();
    let command: string | undefined;
    try {
      command = (request.postDataJSON() as { command?: string }).command;
    } catch {
      return;
    }
    if (command !== "create_local_terminal_session") return;
    void response
      .json()
      .then((body: { result?: { sessionId?: string } }) => {
        if (body.result?.sessionId) sessions.add(body.result.sessionId);
      })
      .catch(() => undefined);
  });
  await page.route("**/__orkestrator/invoke", async (route) => {
    // The credential-free fixture exercises terminals, not login.
    let command: string | undefined;
    try {
      command = (route.request().postDataJSON() as { command?: string }).command;
    } catch {
      // Not a command.
    }
    if (command === "check_claude_cli") return route.fulfill({ json: { result: false } });
    return route.fallback();
  });
  // The session cookie is per host, so every link on 127.0.0.1 shares it.
  await page.goto(new URL(mintLoginPath(), link.url).href, { waitUntil: "domcontentloaded" });
  const expand = page.getByRole("button", { name: `Expand project ${options.projectName}` });
  const entry = page.getByText(options.environmentName, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 45_000 });
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await entry.click();
  await expect(page.locator(".xterm:visible")).toHaveCount(options.terminals, { timeout: 60_000 });
  await expect.poll(() => sessions.size, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  return { page, link, sessions };
}

async function openFilesPanel(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: "Show file panel" });
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole("button", { name: "Hide file panel" })).toBeVisible();
}

const snapshotOf = (page: Page) => page.evaluate(() => window.outageProbe.snapshot());

/** The page's rendered terminal text, from xterm's own buffer. */
function renderedTerminal(page: Page, environmentId: string, tabId: string): Promise<string> {
  return page.evaluate(
    async ({ environmentId, tabId }) => {
      const modulePath = "/src/stores/terminalPortalStore.ts";
      const { useTerminalPortalStore } = await import(/* @vite-ignore */ modulePath);
      const buffer = useTerminalPortalStore.getState().getTerminal(environmentId, tabId)?.terminal
        .buffer.active;
      if (!buffer) return "";
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        const text = line?.translateToString(true) ?? "";
        // A wrapped row continues the logical line above it.
        if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      return lines.join("\n");
    },
    { environmentId, tabId },
  );
}

const attemptTimes = (
  link: OutageLink,
  kind: LinkRequestKind,
  since: number,
  until = Number.POSITIVE_INFINITY,
): number[] =>
  link.requests
    .filter((request) => request.kind === kind && request.at >= since && request.at < until)
    .map((request) => request.at)
    // Chromium silently resends a request that died on a reused idle socket.
    .filter((at, index, times) => index === 0 || at - times[index - 1]! > NETWORK_RESEND_MS);

/** When the terminal had a working transport again: the socket, or its HTTP fallback. */
function terminalBackAt(link: OutageLink, since: number): number | null {
  const times = (["terminal-stream", "terminal-socket"] as const)
    .map((kind) => firstAnswered(link, kind, since))
    .filter((time) => time !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

const firstAnswered = (link: OutageLink, kind: LinkRequestKind, since: number): number | null =>
  link.requests.find(
    (request: LinkRequest) =>
      request.kind === kind &&
      request.at >= since &&
      request.answeredAt !== undefined &&
      request.status !== undefined &&
      request.status < 400,
  )?.answeredAt ?? null;

/** Equal jitter on the event ladder: delay n sits in [base/2, base], base 2, 4, 8, 16 s. */
const eventJitterWindowMs = (rung: number) =>
  Math.min(EVENT_RECONNECT_CAP_MS, EVENT_RECONNECT_FIRST_MS * 2 ** rung) / 2;

function writeEvidence(testInfo: TestInfo, name: string, evidence: unknown): void {
  const body = JSON.stringify(evidence, null, 2);
  writeFileSync(testInfo.outputPath(`${name}.json`), `${body}\n`);
  testInfo.annotations.push({ type: name, description: body });
  console.log(`[client-outage] ${name} ${JSON.stringify(evidence)}`);
}

async function fixtureProject(invoke: Invoke, status: Status): Promise<Project> {
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  if (fixture) return fixture;
  // A replacement backend does not know testProject through dev:status alone,
  // but the project list is durable, so this only fails on a wrong profile.
  throw new Error("The fixture project is missing from this profile");
}

for (const transport of ["http-sse", "websocket"] as const) {
  test(`dropped link, ${transport}: banner, paused reads, spread retries, terminals return`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(OUTAGE_MS + 240_000);
    const status = profileStatus();
    expect(status.status).toBe("ready");
    const invoke = directInvoke(status);
    const fixture = await fixtureProject(invoke, status);
    const environments = await createEnvironments(invoke, fixture, `drop-${transport}`);
    const [split, single] = environments;
    await installProbe(context, transport);
    const tabs: Tab[] = [];
    try {
      tabs.push(
        await openTab(context, {
          owner: "tab-split",
          status,
          projectName: fixture.name,
          environmentName: split.name,
          terminals: 2,
        }),
        await openTab(context, {
          owner: "tab-single",
          status,
          projectName: fixture.name,
          environmentName: single.name,
          terminals: 1,
        }),
        await openTab(context, {
          owner: "tab-second-window",
          status,
          projectName: fixture.name,
          environmentName: single.name,
          terminals: 1,
        }),
      );
      // Let startup reads and terminal bring-up settle before measuring.
      await tabs[0]!.page.waitForTimeout(5_000);
      const session = Array.from(tabs[1]!.sessions)[0]!;

      const cutAt = Date.now();
      for (const tab of tabs) tab.link.setMode("reset");

      // The banner stays away for the delay, then every tab shows it.
      await tabs[0]!.page.waitForTimeout(BANNER_DELAY_MS - 1_000);
      for (const tab of tabs) {
        await expect(tab.page.getByTestId("connection-status-banner")).toHaveCount(0);
      }
      for (const tab of tabs) {
        await expect(tab.page.getByTestId("connection-status-banner")).toBeVisible({
          timeout: 10_000,
        });
      }
      // Output the disconnected tabs must recover from the snapshot.
      const marker = `OUTAGE-${Date.now()}`;
      await invoke("local_terminal_write", {
        sessionId: session,
        data: `echo ${marker}-$((6*7))\n`,
      });

      const pausedAt = Date.now() + 2_000;
      await tabs[0]!.page.waitForTimeout(2_000);
      const whenPaused = await Promise.all(tabs.map((tab) => snapshotOf(tab.page)));
      await tabs[0]!.page.waitForTimeout(Math.max(0, cutAt + OUTAGE_MS - Date.now()));
      const restoredAt = Date.now();
      const duringOutage = await Promise.all(tabs.map((tab) => snapshotOf(tab.page)));
      for (const tab of tabs) tab.link.setMode("up");

      for (const tab of tabs) {
        await expect(tab.page.getByTestId("connection-status-banner")).toHaveCount(0, {
          timeout: RECONNECT_BUDGET_MS,
        });
      }
      // The outage output reached the rendered terminal without a reload.
      await expect
        .poll(() => renderedTerminal(tabs[1]!.page, single.id, "tab-first"), {
          timeout: RECONNECT_BUDGET_MS,
        })
        .toContain(`${marker}-42`);
      await expect
        .poll(() => renderedTerminal(tabs[2]!.page, single.id, "tab-first"), {
          timeout: RECONNECT_BUDGET_MS,
        })
        .toContain(`${marker}-42`);
      await tabs[0]!.page.waitForTimeout(2_000);
      const after = await Promise.all(tabs.map((tab) => snapshotOf(tab.page)));

      const perTab = tabs.map((tab, index) => {
        const banner = duringOutage[index]!.banners.findLast((entry) => entry.visible);
        const cleared = after[index]!.banners.findLast((entry) => !entry.visible);
        const paused = duringOutage[index]!.disconnected.findLast((entry) => entry.value);
        const reconnect = after[index]!.disconnected.findLast((entry) => !entry.value);
        const mainBack = firstAnswered(tab.link, "main-stream", restoredAt);
        const terminalBack = terminalBackAt(tab.link, restoredAt);
        const invokes = tab.link.requests.filter(
          (request) =>
            request.kind === "invoke" && request.at >= pausedAt && request.at < restoredAt,
        );
        const invokeCounts: Record<string, number> = {};
        for (const request of invokes) {
          const name = request.command ?? "unknown";
          invokeCounts[name] = (invokeCounts[name] ?? 0) + 1;
        }
        return {
          owner: tab.link.owner,
          bannerAfterMs: banner ? banner.at - cutAt : null,
          bannerClearedAfterRestoreMs: cleared ? cleared.at - restoredAt : null,
          pausedAfterMs: paused ? paused.at - cutAt : null,
          resumedAfterRestoreMs: reconnect ? reconnect.at - restoredAt : null,
          mainBackAfterRestoreMs: mainBack === null ? null : mainBack - restoredAt,
          terminalBackAfterRestoreMs: terminalBack === null ? null : terminalBack - restoredAt,
          terminalBehindMainMs:
            terminalBack === null || mainBack === null ? null : terminalBack - mainBack,
          invokesWhilePaused: invokeCounts,
          coordinatorReadsWhilePaused:
            duringOutage[index]!.readsStarted - whenPaused[index]!.readsStarted,
          mainAttempts: attemptTimes(tab.link, "main-stream", cutAt, restoredAt).map(
            (at) => at - cutAt,
          ),
          terminalStreamAttempts: attemptTimes(tab.link, "terminal-stream", cutAt, restoredAt).map(
            (at) => at - cutAt,
          ),
          terminalSocketAttempts: attemptTimes(tab.link, "terminal-socket", cutAt, restoredAt).map(
            (at) => at - cutAt,
          ),
          freshnessChanges: after[index]!.freshness.length,
        };
      });
      const rungs = (kind: LinkRequestKind) =>
        retryRungs(
          new Map(
            tabs.map((tab) => [tab.link.owner, attemptTimes(tab.link, kind, cutAt, restoredAt)]),
          ),
        );
      writeEvidence(testInfo, `dropped-link-${transport}`, {
        outageMs: restoredAt - cutAt,
        perTab,
        mainRungs: rungs("main-stream"),
        terminalStreamRungs: rungs("terminal-stream"),
        terminalSocketRungs: rungs("terminal-socket"),
        mainSpread: retriesAreSpread(rungs("main-stream"), eventJitterWindowMs),
      });

      for (const tabResult of perTab) {
        expect(tabResult.bannerAfterMs).toBeGreaterThanOrEqual(BANNER_DELAY_MS - 100);
        expect(tabResult.bannerAfterMs).toBeLessThan(BANNER_DELAY_MS + 4_000);
        expect(tabResult.pausedAfterMs).toBeLessThan(2_000);
        expect(tabResult.coordinatorReadsWhilePaused).toBe(0);
        expect(tabResult.invokesWhilePaused).toEqual({});
        expect(tabResult.bannerClearedAfterRestoreMs).not.toBeNull();
        expect(tabResult.resumedAfterRestoreMs).not.toBeNull();
        expect(tabResult.terminalBackAfterRestoreMs).not.toBeNull();
        // Terminals come back with the main stream, not on a later rung.
        expect(tabResult.terminalBehindMainMs ?? 0).toBeLessThan(2_000);
        expect(tabResult.freshnessChanges).toBeLessThanOrEqual(1);
      }
      expect(retriesAreSpread(rungs("main-stream"), eventJitterWindowMs)).toBe(true);
    } finally {
      for (const tab of tabs) {
        await tab.page.close().catch(() => undefined);
        await tab.link.close();
      }
      await removeEnvironments(invoke, environments);
    }
  });
}

for (const transport of ["http-sse", "websocket"] as const) {
  test(`a silently dropped link is noticed, ${transport}: banner, paused reads, recovery`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    const status = profileStatus();
    const invoke = directInvoke(status);
    const fixture = await fixtureProject(invoke, status);
    const environments = await createEnvironments(invoke, fixture, `silent-${transport}`);
    const [, single] = environments;
    await installProbe(context, transport);
    let tab: Tab | undefined;
    try {
      tab = await openTab(context, {
        owner: "tab-blackhole",
        status,
        projectName: fixture.name,
        environmentName: single.name,
        terminals: 1,
      });
      await tab.page.waitForTimeout(5_000);
      const cutAt = Date.now();
      tab.link.setMode("blackhole");
      const banner = tab.page.getByTestId("connection-status-banner");
      await banner
        .waitFor({ state: "visible", timeout: SILENT_LINK_BANNER_BUDGET_MS })
        .catch(() => undefined);
      const shownAfterMs = (await banner.count()) > 0 ? Date.now() - cutAt : null;
      const restoredAt = Date.now();
      tab.link.setMode("up");
      await expect(banner).toHaveCount(0, { timeout: RECONNECT_BUDGET_MS * 2 });
      const clearedAfterRestoreMs = Date.now() - restoredAt;
      const paused = (await snapshotOf(tab.page)).disconnected.find((entry) => entry.value);
      // Output written meanwhile reaches the terminal, on whichever transport returned.
      const marker = `SILENT-${Date.now()}`;
      await invoke("local_terminal_write", {
        sessionId: Array.from(tab.sessions)[0]!,
        data: `echo ${marker}-$((6*7))\n`,
      });
      await expect
        .poll(() => renderedTerminal(tab!.page, single.id, "tab-first"), {
          timeout: RECONNECT_BUDGET_MS * 2,
        })
        .toContain(`${marker}-42`);
      writeEvidence(testInfo, `silent-link-${transport}`, {
        bannerAfterMs: shownAfterMs,
        pausedAfterMs: paused ? paused.at - cutAt : null,
        clearedAfterRestoreMs,
        terminalReturnedAfterRestoreMs: Date.now() - restoredAt,
        mainAttempts: attemptTimes(tab.link, "main-stream", cutAt).map((at) => at - cutAt),
      });
      expect(shownAfterMs, "the banner never appeared on a silent link").not.toBeNull();
      expect(paused).toBeTruthy();
    } finally {
      await tab?.page.close().catch(() => undefined);
      await tab?.link.close();
      await removeEnvironments(invoke, environments);
    }
  });
}

for (const transport of ["http-sse", "websocket"] as const) {
  test(`terminal backpressure, ${transport}: a desync recovers the exact screen`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(300_000);
    const status = profileStatus();
    const invoke = directInvoke(status);
    const fixture = await fixtureProject(invoke, status);
    const environments = await createEnvironments(invoke, fixture, `flood-${transport}`);
    const [, single] = environments;
    await installProbe(context, transport);
    let tab: Tab | undefined;
    try {
      tab = await openTab(context, {
        owner: "tab-flood",
        status,
        projectName: fixture.name,
        environmentName: single.name,
        terminals: 1,
      });
      const sessionId = Array.from(tab.sessions)[0]!;
      await tab.page.waitForTimeout(3_000);
      if (transport === "websocket") {
        await expect
          .poll(() => firstAnswered(tab!.link, "terminal-socket", 0), { timeout: 30_000 })
          .not.toBeNull();
      }
      const before = await snapshotOf(tab.page);

      // Stop reading the terminal transport, then flood it, so the gateway's
      // own bounded queue overflows against real TCP backpressure.
      tab.link.setTerminalStall(true);
      const end = `FLOOD-END-${Date.now()}`;
      await invoke("local_terminal_write", {
        sessionId,
        // Not `seq`: on macOS it switches to scientific notation past a million.
        data: `awk 'BEGIN{for(i=1;i<=${FLOOD_LINES};i++)print i}'; echo ${end}-$((6*7))\n`,
      });
      const output = async () =>
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output;
      await expect
        .poll(async () => (await output()).includes(`${end}-42`), { timeout: 180_000 })
        .toBe(true);
      await tab.page.waitForTimeout(2_000);
      tab.link.setTerminalStall(false);

      // The rendered screen converges on the authoritative snapshot exactly.
      await expect
        .poll(() => renderedTerminal(tab!.page, single.id, "tab-first"), { timeout: 120_000 })
        .toContain(`${end}-42`);
      await expect
        .poll(
          async () =>
            lastLines(await renderedTerminal(tab!.page, single.id, "tab-first"), COMPARED_LINES),
          { timeout: 30_000 },
        )
        .toEqual(lastLines(visibleText(await output()), COMPARED_LINES));
      const rendered = await renderedTerminal(tab.page, single.id, "tab-first");
      const numbers = rendered
        .split("\n")
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
      const gaps = numbers.filter((value, index) => index > 0 && value !== numbers[index - 1]! + 1);
      const after = await snapshotOf(tab.page);
      writeEvidence(testInfo, `backpressure-${transport}`, {
        floodLines: FLOOD_LINES,
        desyncNotices: after.desyncs - before.desyncs,
        renderedNumberedLines: numbers.length,
        lastNumber: numbers.at(-1) ?? null,
        gapsInRenderedSequence: gaps.length,
      });
      // Otherwise the throttle proved nothing about recovery.
      expect(after.desyncs - before.desyncs).toBeGreaterThan(0);
      expect(numbers.at(-1)).toBe(FLOOD_LINES);
      expect(gaps).toEqual([]);
    } finally {
      await tab?.page.close().catch(() => undefined);
      await tab?.link.close();
      await removeEnvironments(invoke, environments);
    }
  });
}

const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "");

/** The last lines holding text; prompts and trailing blanks render differently. */
function lastLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^\d+$/.test(line))
    .slice(-count);
}

test("no indicator flickers on quiet safety reads", async ({ context }, testInfo) => {
  test.setTimeout(180_000);
  const status = profileStatus();
  const invoke = directInvoke(status);
  const fixture = await fixtureProject(invoke, status);
  const environments = await createEnvironments(invoke, fixture, "quiet");
  const [, single] = environments;
  await installProbe(context, "http-sse");
  let tab: Tab | undefined;
  try {
    // A recorded PR, for the View PR action. The profile has no GitHub login, so
    // the monitor's own read of it fails locally and never reaches a real PR.
    await invoke("set_environment_pr", {
      environmentId: single.id,
      prUrl: "https://github.com/orkestrator-fixture/none/pull/1",
      prState: "open",
      hasMergeConflicts: null,
    });
    tab = await openTab(context, {
      owner: "tab-quiet",
      status,
      projectName: fixture.name,
      environmentName: single.name,
      terminals: 1,
    });
    await openFilesPanel(tab.page);
    const worktree = (await invoke<Environment>("get_environment", { environmentId: single.id }))
      .worktreePath!;
    writeFileSync(path.join(worktree, "quiet-change.txt"), "a change for the diff badge\n");
    // A change for the diff badge and the Files panel's lists to show.
    await expect(
      tab.page
        .getByTestId("environment-change-badge")
        .or(tab.page.getByTestId("environment-diff-stats"))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await tab.page.waitForTimeout(10_000);
    const before = await snapshotOf(tab.page);
    const startedAt = Date.now();
    // The five-minute safety cadence, brought forward: each registered view runs
    // its conditional read, normally answered `unchanged`.
    let safetyChecks = 0;
    while (Date.now() - startedAt < QUIET_MS) {
      await tab.page.evaluate(async () => {
        const modulePath = "/src/lib/resource-sync.ts";
        const { requestViewSafetyChecks } = await import(/* @vite-ignore */ modulePath);
        requestViewSafetyChecks("interval");
      });
      safetyChecks += 1;
      await tab.page.waitForTimeout(5_000);
    }
    const after = await snapshotOf(tab.page);
    const invokes = tab.link.requests.filter(
      (request) => request.kind === "invoke" && request.at >= startedAt,
    );
    const commands: Record<string, number> = {};
    for (const request of invokes) {
      const name = request.command ?? "unknown";
      commands[name] = (commands[name] ?? 0) + 1;
    }
    const viewPrVisible = await tab.page.getByRole("button", { name: /view pr/i }).count();
    writeEvidence(testInfo, "quiet-reads", {
      quietMs: QUIET_MS,
      safetyChecks,
      viewPrVisible,
      coordinatorReads: after.readsStarted - before.readsStarted,
      commands,
      // What the page already showed; a failed PR read may rightly stay marked.
      settledIndicators: before.freshness.at(-1)?.kind ?? null,
      freshnessChanges: after.freshness.slice(before.freshness.length),
      bannerChanges: after.banners.slice(before.banners.length),
    });
    // Views really re-read, and none of those reads changed what is on screen.
    expect(after.readsStarted).toBeGreaterThan(before.readsStarted);
    expect(Object.keys(commands).length).toBeGreaterThan(1);
    expect(after.freshness.slice(before.freshness.length)).toEqual([]);
    expect(after.banners.slice(before.banners.length)).toEqual([]);
  } finally {
    await tab?.page.close().catch(() => undefined);
    await tab?.link.close();
    await removeEnvironments(invoke, environments);
  }
});

// Direct clients: the real gateway code in a page, with a bearer token, one
// link per client so each attempt has an owner.
type DirectClientReport = {
  states: Array<{ at: number; state: string }>;
  desyncs: Array<{ at: number; session: string }>;
  resyncs: Array<{ at: number }>;
  recoveries: Array<{
    at: number;
    session: string;
    via: "snapshot" | "main-resync" | "replay";
    recoveredMissedOutput: boolean;
  }>;
};
declare global {
  interface Window {
    directClient: {
      report(): DirectClientReport;
      dispose(): void;
    };
  }
}

async function startDirectClient(
  page: Page,
  link: OutageLink,
  options: { token: string; sessionIds: string[]; transport: Transport; expectedOutput?: string },
): Promise<void> {
  await page.goto(new URL(BLANK_PATH, link.url).href);
  await page.evaluate(
    async ({ baseUrl, token, sessionIds, transport, expectedOutput }) => {
      const modulePath = "/src/lib/native/web-gateway.ts";
      const { createBrowserGatewayApi } = await import(/* @vite-ignore */ modulePath);
      const api = createBrowserGatewayApi({ baseUrl, token, terminalTransport: transport });
      const report: DirectClientReport = { states: [], desyncs: [], resyncs: [], recoveries: [] };
      api.eventStreamConnection.subscribe((state: string) => {
        report.states.push({ at: Date.now(), state });
      });
      const recoverSnapshot = async (session: string, via: "snapshot" | "main-resync") => {
        try {
          const snapshot = await api.invoke("get_terminal_output_snapshot", {
            sessionId: session,
          });
          const recoveredMissedOutput =
            typeof expectedOutput === "string" && snapshot.output.includes(expectedOutput);
          await api.invoke("terminal_snapshot_applied", {
            sessionId: session,
            generation: snapshot.generation,
            revision: snapshot.revision,
          });
          report.recoveries.push({
            at: Date.now(),
            session,
            via,
            recoveredMissedOutput,
          });
        } catch {
          // A reconnect can lose its snapshot request too. Keep that failure
          // observable without leaking terminal bytes or an unhandled promise.
          report.recoveries.push({
            at: Date.now(),
            session,
            via,
            recoveredMissedOutput: false,
          });
          await api.invoke("terminal_snapshot_failed", { sessionId: session });
        }
      };
      const stops = [
        api.listen("environment-updated", () => undefined),
        // Like useTerminal, reconcile after a fresh backend generation even if
        // a socket cursor can be reused without a channel-level desync.
        api.listen("native-event-stream-connected", async () => {
          report.resyncs.push({ at: Date.now() });
          await Promise.all(sessionIds.map((session) => recoverSnapshot(session, "main-resync")));
        }),
      ];
      for (const session of sessionIds) {
        const decoder = new TextDecoder();
        let outputTail = "";
        stops.push(
          api.listen(`terminal-output-${session}`, async (payload: unknown) => {
            const desynced = (payload as { desynced?: boolean } | null)?.desynced === true;
            if (!desynced) {
              const output = payload as { bytes?: Uint8Array; text?: string } | null;
              const text =
                output?.bytes instanceof Uint8Array
                  ? decoder.decode(output.bytes, { stream: true })
                  : (output?.text ?? "");
              // Keep terminal bytes in the page only; evidence records a boolean.
              outputTail = (outputTail + text).slice(-4096);
              if (expectedOutput && outputTail.includes(expectedOutput)) {
                report.recoveries.push({
                  at: Date.now(),
                  session,
                  via: "replay",
                  recoveredMissedOutput: true,
                });
                outputTail = "";
              }
              return;
            }
            report.desyncs.push({ at: Date.now(), session });
            // Follow the consumer's recovery contract: a notice must produce an
            // authoritative snapshot, then acknowledge its cursor to the socket.
            await recoverSnapshot(session, "snapshot");
          }),
        );
      }
      window.directClient = {
        report: () => report,
        dispose: () => {
          for (const stop of stops) stop();
        },
      };
    },
    { baseUrl: link.url, ...options },
  );
}

for (const transport of ["http-sse", "websocket"] as const) {
  test(`backend restart, direct clients on ${transport}: spread retries, terminals return with the stream`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(OUTAGE_MS + 240_000);
    const status = profileStatus();
    const invoke = directInvoke(status);
    const token = gatewayToken(status);
    const fixture = await fixtureProject(invoke, status);
    const environments = await createEnvironments(invoke, fixture, `restart-${transport}`);
    const [, single] = environments;
    const sessionId = (
      await invoke<{ sessionId: string }>("create_local_terminal_session", {
        environmentId: single.id,
        cols: 80,
        rows: 24,
        terminalKey: "direct-restart",
      })
    ).sessionId;
    await invoke("start_local_terminal_session", { sessionId });
    const clients: Array<{ page: Page; link: OutageLink }> = [];
    const marker = `RESTART-MISSED-${Date.now()}-42`;
    try {
      for (const owner of ["direct-1", "direct-2", "direct-3", "direct-4"]) {
        const link = await startOutageLink({
          owner,
          gatewayUrl: status.browserUrl!,
          rendererUrl: status.rendererUrl!,
        });
        const page = await context.newPage();
        clients.push({ page, link });
        await startDirectClient(page, link, {
          token,
          sessionIds: [sessionId],
          transport,
          expectedOutput: marker,
        });
      }
      for (const client of clients) {
        await expect
          .poll(() => firstAnswered(client.link, "main-stream", 0), { timeout: 30_000 })
          .not.toBeNull();
      }
      await clients[0]!.page.waitForTimeout(2_000);

      for (const { link } of clients) link.setMode("reset");
      const stoppedAt = Date.now();
      await stopBackend(status);
      const gone = Date.now();
      await clients[0]!.page.waitForTimeout(Math.max(0, stoppedAt + OUTAGE_MS - Date.now()));
      const startingAt = Date.now();
      await startBackend(status);
      const listeningAt = Date.now();
      // Re-establish the shell as a terminal consumer does after a backend
      // restart, and generate output while every client is still cut off.
      await invoke("start_local_terminal_session", { sessionId });
      await invoke("local_terminal_write", {
        sessionId,
        // The computed result cannot be mistaken for the echoed command text.
        data: `echo ${marker.slice(0, -2)}$((6*7))\n`,
      });
      await expect
        .poll(async () =>
          (
            await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })
          ).output.includes(marker),
        )
        .toBe(true);
      for (const { link } of clients) link.setMode("up");

      const terminalKind: LinkRequestKind =
        transport === "websocket" ? "terminal-socket" : "terminal-stream";
      for (const client of clients) {
        await expect
          .poll(() => firstAnswered(client.link, "main-stream", listeningAt - 1_000), {
            timeout: RECONNECT_BUDGET_MS * 2,
          })
          .not.toBeNull();
        await expect
          .poll(() => terminalBackAt(client.link, listeningAt - 1_000), {
            timeout: RECONNECT_BUDGET_MS * 2,
          })
          .not.toBeNull();
      }
      for (const { page } of clients) {
        await expect
          .poll(
            async () => {
              const report = await page.evaluate(() => window.directClient.report());
              return {
                desyncs: report.desyncs.filter((entry) => entry.at >= listeningAt),
                resyncs: report.resyncs.filter((entry) => entry.at >= listeningAt),
                recoveries: report.recoveries.filter((entry) => entry.at >= listeningAt),
              };
            },
            { timeout: RECONNECT_BUDGET_MS * 2 },
          )
          .toMatchObject({
            recoveries: expect.arrayContaining([
              expect.objectContaining({ session: sessionId, recoveredMissedOutput: true }),
            ]),
          });
      }

      const perClient = await Promise.all(
        clients.map(async ({ page, link }) => {
          const report = await page.evaluate(() => window.directClient.report());
          const mainBack = firstAnswered(link, "main-stream", listeningAt - 1_000)!;
          const terminalBack = terminalBackAt(link, listeningAt - 1_000)!;
          return {
            owner: link.owner,
            mainBackAfterListeningMs: mainBack - listeningAt,
            terminalBehindMainMs: terminalBack - mainBack,
            stateChanges: report.states.map((entry) => ({
              state: entry.state,
              afterStopMs: entry.at - stoppedAt,
            })),
            terminalDesyncsAfterBack: report.desyncs.filter((entry) => entry.at >= listeningAt)
              .length,
            mainResyncsAfterBack: report.resyncs.filter((entry) => entry.at >= listeningAt).length,
            replayRecoveredMissedOutput: report.recoveries.some(
              (entry) =>
                entry.at >= listeningAt &&
                entry.session === sessionId &&
                entry.via === "replay" &&
                entry.recoveredMissedOutput,
            ),
            recoveredMissedOutput: report.recoveries.some(
              (entry) =>
                entry.at >= listeningAt &&
                entry.session === sessionId &&
                entry.recoveredMissedOutput,
            ),
            mainAttempts: attemptTimes(link, "main-stream", stoppedAt, listeningAt).map(
              (at) => at - stoppedAt,
            ),
            terminalAttempts: attemptTimes(link, terminalKind, stoppedAt, listeningAt).map(
              (at) => at - stoppedAt,
            ),
          };
        }),
      );
      const rungs = (kind: LinkRequestKind) =>
        retryRungs(
          new Map(
            clients.map(({ link }) => [
              link.owner,
              attemptTimes(link, kind, stoppedAt, startingAt),
            ]),
          ),
        );
      writeEvidence(testInfo, `backend-restart-${transport}`, {
        stopTookMs: gone - stoppedAt,
        backendStartTookMs: listeningAt - startingAt,
        perClient,
        mainRungs: rungs("main-stream"),
        terminalRungs: rungs(terminalKind),
      });
      expect(retriesAreSpread(rungs("main-stream"), eventJitterWindowMs)).toBe(true);
      // A terminal's own ladder may find the backend first; it must never lag.
      for (const result of perClient) {
        expect(result.terminalBehindMainMs).toBeLessThan(2_000);
        // SSE notifies per-terminal snapshot recovery. WebSockets can also
        // reconcile a new backend generation through the main stream or replay
        // every missed revision exactly, which needs no desync notification.
        if (transport === "http-sse") {
          expect(result.terminalDesyncsAfterBack).toBeGreaterThan(0);
        } else if (!result.replayRecoveredMissedOutput) {
          expect(result.terminalDesyncsAfterBack + result.mainResyncsAfterBack).toBeGreaterThan(0);
        }
        expect(result.recoveredMissedOutput).toBe(true);
      }
    } finally {
      for (const { page, link } of clients) {
        await page.close().catch(() => undefined);
        await link.close();
      }
      await removeEnvironments(invoke, environments).catch(() => undefined);
    }
  });
}

test("quick backend restarts: first reconnect against the banner's delay", async ({
  context,
}, testInfo) => {
  test.setTimeout(QUICK_RESTARTS * 60_000 + 120_000);
  const status = profileStatus();
  const token = gatewayToken(status);
  const clients: Array<{ page: Page; link: OutageLink }> = [];
  try {
    for (const owner of ["quick-1", "quick-2", "quick-3", "quick-4"]) {
      const link = await startOutageLink({
        owner,
        gatewayUrl: status.browserUrl!,
        rendererUrl: status.rendererUrl!,
      });
      const page = await context.newPage();
      clients.push({ page, link });
      await startDirectClient(page, link, { token, sessionIds: [], transport: "http-sse" });
    }
    const samples: Array<{ backendDownMs: number; firstReconnectMs: number[] }> = [];
    for (let round = 0; round < QUICK_RESTARTS; round += 1) {
      await clients[0]!.page.waitForTimeout(35_000); // Past the healthy interval: rung one.
      const stoppedAt = Date.now();
      await stopBackend(status);
      await startBackend(status);
      const listeningAt = Date.now();
      for (const { link } of clients) {
        await expect
          .poll(() => firstAnswered(link, "main-stream", stoppedAt), {
            timeout: RECONNECT_BUDGET_MS * 2,
          })
          .not.toBeNull();
      }
      samples.push({
        backendDownMs: listeningAt - stoppedAt,
        firstReconnectMs: clients
          .map(({ link }) => firstAnswered(link, "main-stream", stoppedAt)! - stoppedAt)
          .sort((first, second) => first - second),
      });
    }
    const all = samples.flatMap((sample) => sample.firstReconnectMs);
    const underDelay = all.filter((ms) => ms < BANNER_DELAY_MS).length;
    writeEvidence(testInfo, "quick-restarts", { samples, underDelay, total: all.length });
    // The todo's rule: the first reconnect usually lands inside the banner's delay.
    expect(underDelay / all.length).toBeGreaterThan(0.5);
  } finally {
    for (const { page, link } of clients) {
      await page.close().catch(() => undefined);
      await link.close();
    }
  }
});

test("backend restart, real UI: banner during the outage, login page on the lapse, fresh link recovers", async ({
  context,
}, testInfo) => {
  test.setTimeout(240_000);
  const status = profileStatus();
  const invoke = directInvoke(status);
  const fixture = await fixtureProject(invoke, status);
  const environments = await createEnvironments(invoke, fixture, "restart-ui");
  const [, single] = environments;
  await installProbe(context, "http-sse");
  let tab: Tab | undefined;
  try {
    tab = await openTab(context, {
      owner: "tab-restart",
      status,
      projectName: fixture.name,
      environmentName: single.name,
      terminals: 1,
    });
    await tab.page.waitForTimeout(3_000);
    const stoppedAt = Date.now();
    await stopBackend(status);
    await expect(tab.page.getByTestId("connection-status-banner")).toBeVisible({ timeout: 15_000 });
    const before = await snapshotOf(tab.page);
    const bannerAt = before.banners.findLast((entry) => entry.visible)!.at;
    const startingAt = Date.now();
    await startBackend(status);
    const listeningAt = Date.now();

    // The session lapsed with the old backend. Whatever notices first, the tab
    // must not sit on a stale screen behind a "Reconnecting" banner.
    await expect
      .poll(() => new URL(tab!.page.url()).pathname, { timeout: LAPSE_BUDGET_MS })
      .toBe("/__orkestrator/login");
    const loginAt = Date.now();

    await tab.page.goto(new URL(mintLoginPath(), tab.link.url).href, {
      waitUntil: "domcontentloaded",
    });
    const entry = tab.page.getByText(single.name, { exact: true }).first();
    const expand = tab.page.getByRole("button", { name: `Expand project ${fixture.name}` });
    await expect(expand.or(entry)).toBeVisible({ timeout: 45_000 });
    await expect(tab.page.getByTestId("connection-status-banner")).toHaveCount(0);
    writeEvidence(testInfo, "backend-restart-ui", {
      bannerAfterStopMs: bannerAt - stoppedAt,
      backendStartTookMs: listeningAt - startingAt,
      loginPageAfterListeningMs: loginAt - listeningAt,
    });
  } finally {
    await tab?.page.close().catch(() => undefined);
    await tab?.link.close();
    await removeEnvironments(invoke, environments).catch(() => undefined);
  }
});
