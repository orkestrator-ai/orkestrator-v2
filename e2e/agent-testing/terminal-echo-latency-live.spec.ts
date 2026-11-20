/**
 * Key-to-echo latency in a real browser on a loaded `dev:test` profile
 * (to-do 8312 task 3; results in docs/development/terminal-latency.md).
 *
 * One Chromium page types into a terminal running `cat` in raw mode (the echo
 * comes from a user-space process, as a shell's does) while other terminals
 * run `apps/backend/scripts/terminal-latency/producer.ts` build and tool loads
 * and Claude agents stream answers from a loopback model
 * (`fake-anthropic-model.ts`, through the profile's own isolated
 * `CLAUDE_CONFIG_DIR`, so nothing is billed). Each key's latency is timed in
 * the page with `performance.now()`: from the keydown event's own timestamp
 * (so time the event waited behind other main-thread work counts) to the
 * mutation of xterm.js's rows that shows the echo.
 *
 * Variants, each in its own environment so only the parts under test mount:
 *
 * - `idle`: a terminal-only environment, no load at all.
 * - `backend-only`: the same environment; the load terminals and agents run in
 *   other environments, so the backend carries them but this page parses none.
 * - `agent-visible`: an environment showing a streaming agent beside the
 *   typing terminal; the load terminals still run elsewhere.
 * - `hidden-tabs`: the same as `agent-visible`, but the load terminals are
 *   hidden tabs beside the typing tab, so the page receives and parses them
 *   (in idle time, `apps/web/src/lib/terminal-background-writes.ts`).
 * - `hidden-tabs-direct`: `hidden-tabs` with the renderer's measurement switch
 *   off, so hidden tabs write straight into xterm.js as before to-do 8312.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO=1`), against a
 * credential-free profile of its own:
 *
 *   env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile echo8312 --fixture --no-agent-credentials --no-host-seed \
 *     --headless --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=echo8312 ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO=1 \
 *     mise run test:logged -- --name terminal-echo -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts terminal-echo-latency-live.spec.ts
 *
 * Evidence holds numbers and labels only, never terminal output, prompts or
 * tokens: the typed keys are a fixed cycle of letters and digits.
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BrowserContext } from "@playwright/test";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = { status: string; profile?: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Variant = "idle" | "backend-only" | "agent-visible" | "hidden-tabs" | "hidden-tabs-direct";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "echo8312";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO === "1";
const FAKE_MODEL_PORT = Number(process.env.ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT ?? "0");
const ALL_VARIANTS: Variant[] = [
  "idle",
  "backend-only",
  "agent-visible",
  "hidden-tabs",
  "hidden-tabs-direct",
];
/** The renderer's measurement switch (`terminal-background-writes.ts`). */
const BACKGROUND_WRITES_KEY = "orkestrator-terminal-background-writes";
const VARIANTS = (process.env.ORKESTRATOR_AGENT_TEST_ECHO_VARIANTS ?? ALL_VARIANTS.join(","))
  .split(",")
  .map((variant) => variant.trim())
  .filter((variant): variant is Variant => (ALL_VARIANTS as string[]).includes(variant));
const ROUNDS = Math.max(1, Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_ROUNDS ?? "3"));
const KEYS = Math.max(20, Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_KEYS ?? "200"));
const WARMUP_KEYS = 10;
/** Pause between an echo and the next key, as the loopback benchmark uses. */
const KEY_GAP_MS = 30;
const ECHO_TIMEOUT_MS = 5_000;
/** The load shape: the loopback benchmark's `busy` level. */
const LOAD = {
  build: Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_BUILD ?? "3"),
  tool: Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_TOOL ?? "2"),
  agents: Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_AGENTS ?? "4"),
  buildBytesPerSecond: 256 * 1024,
  toolBurstBytes: 2 * 1024 * 1024,
  toolEveryMs: 1_500,
};
/** Lines per streamed answer, 25 ms apart: long enough to cover a measured run. */
const STREAM_DELTAS = Number(process.env.ORKESTRATOR_AGENT_TEST_ECHO_STREAM ?? "1600");
const KEY_CYCLE = "abcdefghijklmnopqrstuvwxyz0123456789";
const PRODUCER = path.join(repositoryRoot, "apps/backend/scripts/terminal-latency/producer.ts");
const TYPING_TAB = "echo-typing";
const AGENT_TAB = "echo-agent";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO=1 against a disposable profile");

function runtime() {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function readyStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  return status;
}

function mintLoginUrl(): string {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  return login.loginUrl;
}

function bunPath(): string {
  const found = spawnSync("mise", ["which", "bun"], { cwd: repositoryRoot, encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : "bun";
}

function progress(step: string): void {
  console.log(`[terminal-echo] ${new Date().toISOString()} ${step}`);
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)]!.toFixed(1));
}

function summarise(values: number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? Number(sorted.at(-1)!.toFixed(1)) : null,
  };
}

// ---------------------------------------------------------------------------
// Environments

function invokeThrough(page: Page, gatewayUrl: string): Invoke {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", gatewayUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command}: HTTP ${response.status()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

type Leaf = { kind: "leaf"; id: string; activeTabId: string; tabs: Record<string, unknown>[] };

function agentTitle(environmentId: string): string {
  return `Echo agent ${environmentId.slice(0, 8)}`;
}

function agentLeaf(environmentId: string): Leaf {
  return {
    kind: "leaf",
    id: "echo-agent-pane",
    activeTabId: AGENT_TAB,
    tabs: [
      {
        id: AGENT_TAB,
        type: "agent-native",
        displayTitle: agentTitle(environmentId),
        nativeAgentData: { environmentId, platform: "claude", isLocal: true },
        initialAgentModel: "haiku",
      },
    ],
  };
}

function terminalLeaf(hiddenTabs: string[]): Leaf {
  return {
    kind: "leaf",
    id: "echo-terminal-pane",
    activeTabId: TYPING_TAB,
    tabs: [{ id: TYPING_TAB, type: "plain" }, ...hiddenTabs.map((id) => ({ id, type: "plain" }))],
  };
}

async function seedLayout(invoke: Invoke, environmentId: string, root: Record<string, unknown>) {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
  const activePaneId = root.kind === "leaf" ? root.id : "echo-terminal-pane";
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: { version: PANE_LAYOUT_VERSION, containerId: null, activePaneId, root },
  });
}

function split(children: Leaf[]) {
  return {
    kind: "split",
    id: "echo-split",
    direction: "horizontal",
    sizes: [50, 50],
    depth: 0,
    children,
  };
}

async function createEnvironment(invoke: Invoke, fixture: Project, label: string) {
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `echo-${label}-${Date.now().toString(36)}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: created.id });
  await expect
    .poll(
      async () =>
        (await invoke<Environment>("get_environment", { environmentId: created.id })).status,
      { timeout: 180_000 },
    )
    .toBe("running");
  return invoke<Environment>("get_environment", { environmentId: created.id });
}

/** The backend-owned session behind a terminal key (a tab id, or a key no tab has). */
async function terminalSession(invoke: Invoke, environmentId: string, key: string) {
  const created = await invoke<{ sessionId: string } | string>("create_local_terminal_session", {
    environmentId,
    cols: 120,
    rows: 30,
    trackEnvironmentActivity: false,
    terminalKey: key,
  });
  const sessionId = typeof created === "string" ? created : created.sessionId;
  await invoke("start_local_terminal_session", { sessionId }).catch(() => undefined);
  return sessionId;
}

function composer(page: Page) {
  return page
    .getByTestId("shared-native-compose-bar")
    .getByRole("textbox", { name: /^Message Claude/ });
}

const STARTUP_BUTTONS = [
  "Continue without Docker",
  "Continue without GitHub CLI",
  "Continue without Claude",
];

/** Answers the startup checks' dialogs (no Docker, GitHub CLI or Claude login here). */
async function dismissStartupDialogs(page: Page, fixtureName: string) {
  const expand = page.getByRole("button", { name: `Expand project ${fixtureName}` });
  const dialog = page.getByRole("alertdialog");
  let quietSince = Date.now();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const label of STARTUP_BUTTONS) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.isVisible()) await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    if (await dialog.first().isVisible()) quietSince = Date.now();
    else if (
      !(await expand
        .or(page.getByText("echo-", { exact: false }).first())
        .first()
        .isVisible())
    )
      quietSince = Date.now();
    else if (Date.now() - quietSince >= 3_000) break;
    await page.waitForTimeout(200);
  }
  if (await dialog.first().isVisible()) {
    const title = await dialog
      .first()
      .getByRole("heading")
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`an unexpected dialog stayed open: ${title ?? "(untitled)"}`);
  }
  if (await expand.isVisible()) await expand.click();
}

async function selectEnvironment(page: Page, environment: Environment) {
  for (const label of STARTUP_BUTTONS) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click({ timeout: 5_000 }).catch(() => undefined);
  }
  await page.mouse.move(1100, 20);
  await page.getByText(environment.name, { exact: true }).first().click({ timeout: 15_000 });
}

async function openEnvironment(page: Page, environment: Environment, withAgent: boolean) {
  await selectEnvironment(page, environment);
  if (withAgent) await expect(composer(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(`[data-terminal-tab-id="${TYPING_TAB}"] .xterm-rows`)).toBeVisible({
    timeout: 90_000,
  });
}

// ---------------------------------------------------------------------------
// The in-page probe

/**
 * Installs the timing probe on the typing terminal. `arm(suffix)` waits for
 * the next keydown on the terminal and then for xterm's rows to end with
 * `suffix`; `result()` answers both timestamps. A long-task observer and a
 * frame-gap chain record the page's main-thread stalls over the run.
 */
async function installProbe(page: Page) {
  await page.evaluate((tabId) => {
    type Armed = { suffix: string; keyAt: number | null; echoAt: number | null };
    const host = document.querySelector(`[data-terminal-tab-id="${tabId}"]`);
    const rows = host?.querySelector(".xterm-rows");
    if (!host || !rows) throw new Error("typing terminal not found");
    const previous = (window as unknown as { __echoProbe?: { stop(): void } }).__echoProbe;
    previous?.stop();
    let armed: Armed | null = null;
    let resolve: (() => void) | null = null;
    const text = () =>
      Array.from(rows.children)
        .map((row) => row.textContent ?? "")
        .join("")
        .replace(/\s+$/u, "");
    const check = () => {
      if (!armed || armed.echoAt !== null || armed.keyAt === null) return;
      if (text().endsWith(armed.suffix)) {
        armed.echoAt = performance.now();
        resolve?.();
      }
    };
    const onKey = (event: Event) => {
      if (armed && armed.keyAt === null) armed.keyAt = event.timeStamp;
    };
    host.addEventListener("keydown", onKey, { capture: true });
    const observer = new MutationObserver(check);
    observer.observe(rows, { childList: true, subtree: true, characterData: true });
    const longTasks: number[] = [];
    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      longTaskObserver.observe({ type: "longtask", buffered: false });
    } catch {
      longTaskObserver = null;
    }
    const frameGaps: number[] = [];
    let lastFrame = performance.now();
    let frameRunning = true;
    const frame = (at: number) => {
      frameGaps.push(at - lastFrame);
      lastFrame = at;
      if (frameRunning) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    (window as unknown as { __echoProbe: unknown }).__echoProbe = {
      arm(suffix: string) {
        armed = { suffix, keyAt: null, echoAt: null };
      },
      wait(timeoutMs: number) {
        return new Promise<{ keyAt: number | null; echoAt: number | null }>((done) => {
          const finish = () => {
            clearTimeout(timer);
            resolve = null;
            done({ keyAt: armed?.keyAt ?? null, echoAt: armed?.echoAt ?? null });
          };
          const timer = setTimeout(finish, timeoutMs);
          resolve = finish;
          check();
        });
      },
      stats() {
        const gaps = frameGaps.splice(0);
        const tasks = longTasks.splice(0);
        return {
          longTasks: tasks.length,
          longTaskMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)),
          longestTaskMs: Math.round(Math.max(0, ...tasks)),
          frameGaps: gaps,
        };
      },
      stop() {
        observer.disconnect();
        longTaskObserver?.disconnect();
        host.removeEventListener("keydown", onKey, { capture: true });
        frameRunning = false;
      },
    };
  }, TYPING_TAB);
}

/** Every key typed into each typing session so far, so a suffix stays unique across runs. */
const typedCount = new Map<string, number>();

async function typeAndTime(page: Page, sessionId: string) {
  await installProbe(page);
  await page.locator(`[data-terminal-tab-id="${TYPING_TAB}"]`).click();
  // Discard the probe's setup frames.
  await page.evaluate(() =>
    (window as unknown as { __echoProbe: { stats(): unknown } }).__echoProbe.stats(),
  );
  const latencies: number[] = [];
  let timeouts = 0;
  let stats: {
    longTasks: number;
    longTaskMs: number;
    longestTaskMs: number;
    frameGaps: number[];
  } | null = null;
  for (let index = 0; index < WARMUP_KEYS + KEYS; index += 1) {
    if (index === WARMUP_KEYS) {
      await page.evaluate(() =>
        (window as unknown as { __echoProbe: { stats(): unknown } }).__echoProbe.stats(),
      );
    }
    const count = (typedCount.get(sessionId) ?? 0) + 1;
    typedCount.set(sessionId, count);
    let suffix = "";
    for (let at = Math.max(0, count - 12); at < count; at += 1) {
      suffix += KEY_CYCLE[at % KEY_CYCLE.length];
    }
    await page.evaluate(
      (wanted) =>
        (window as unknown as { __echoProbe: { arm(suffix: string): void } }).__echoProbe.arm(
          wanted,
        ),
      suffix,
    );
    await page.keyboard.press(KEY_CYCLE[(count - 1) % KEY_CYCLE.length]!);
    const result = await page.evaluate(
      (timeoutMs) =>
        (
          window as unknown as {
            __echoProbe: {
              wait(ms: number): Promise<{ keyAt: number | null; echoAt: number | null }>;
            };
          }
        ).__echoProbe.wait(timeoutMs),
      ECHO_TIMEOUT_MS,
    );
    if (index >= WARMUP_KEYS) {
      if (result.keyAt !== null && result.echoAt !== null)
        latencies.push(result.echoAt - result.keyAt);
      else timeouts += 1;
    }
    await page.waitForTimeout(KEY_GAP_MS);
  }
  stats = await page.evaluate(() =>
    (
      window as unknown as {
        __echoProbe: {
          stats(): {
            longTasks: number;
            longTaskMs: number;
            longestTaskMs: number;
            frameGaps: number[];
          };
          stop(): void;
        };
      }
    ).__echoProbe.stats(),
  );
  await page.evaluate(() =>
    (window as unknown as { __echoProbe: { stop(): void } }).__echoProbe.stop(),
  );
  const { frameGaps, ...tasks } = stats;
  return {
    keyToEchoMs: { ...summarise(latencies), timeouts },
    frameGapMs: summarise(frameGaps),
    ...tasks,
  };
}

// ---------------------------------------------------------------------------
// The run

type EventLoop = {
  ticks?: number;
  maxLagMs?: number;
  lateTicks?: Record<string, number>;
  stalls?: number;
};

async function backendLoop(page: Page, gatewayUrl: string): Promise<EventLoop> {
  const response = await page.request.get(new URL("/__orkestrator/metrics", gatewayUrl).href);
  if (!response.ok()) return {};
  const body = (await response.json()) as { eventLoop?: EventLoop | null };
  return body.eventLoop ?? {};
}

function loopDelta(before: EventLoop, after: EventLoop) {
  const late: Record<string, number> = {};
  for (const [bucket, count] of Object.entries(after.lateTicks ?? {})) {
    const delta = count - (before.lateTicks?.[bucket] ?? 0);
    if (delta > 0) late[bucket] = delta;
  }
  return {
    ticks: (after.ticks ?? 0) - (before.ticks ?? 0),
    lateTicks: late,
    stalls: (after.stalls ?? 0) - (before.stalls ?? 0),
  };
}

const evidence: { run: Record<string, unknown>; cells: Record<string, unknown>[] } = {
  run: {},
  cells: [],
};
let model: FakeAnthropicModel;
let settingsPath: string;
let priorSettings: string | null = null;

test.beforeAll(async () => {
  model = await startFakeAnthropicModel(FAKE_MODEL_PORT);
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  // Written before any agent tab opens, so every Claude process reads it.
  await fs.writeFile(settingsPath, JSON.stringify(fakeModelClaudeSettings(model.origin)));
  evidence.run = {
    profile,
    variants: VARIANTS,
    rounds: ROUNDS,
    keys: KEYS,
    warmupKeys: WARMUP_KEYS,
    keyGapMs: KEY_GAP_MS,
    load: LOAD,
    streamDeltas: STREAM_DELTAS,
    commit: spawnSync("git", ["rev-parse", "--short=9", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim(),
    host: {
      cpus: (await import("node:os")).cpus().length,
      loadAverage: (await import("node:os")).loadavg(),
    },
    startedAt: new Date().toISOString(),
  };
});

test.afterAll(async () => {
  const file = path.join(test.info().outputDir, "..", `evidence-terminal-echo-${Date.now()}.json`);
  await fs.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  progress(`evidence written to ${file}`);
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

test("key-to-echo latency per load variant", async ({ browser }) => {
  test.setTimeout(90 * 60_000);
  const status = readyStatus();
  const gatewayUrl = status.browserUrl!;
  const contexts: BrowserContext[] = [];
  const created: Environment[] = [];
  let invoke: Invoke | undefined;
  /** A signed-in page in a context of its own, so its selected environment is its own. */
  const signedInPage = async (width: number) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    contexts.push(context);
    await fetchModulesOutsideChromium(context);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const login = new URL(mintLoginUrl());
    const response = await page.goto(new URL(`${login.pathname}${login.search}`, gatewayUrl).href, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.ok() ?? false, "sign-in").toBe(true);
    return page;
  };
  try {
    const measured = await signedInPage(1440);
    invoke = invokeThrough(measured, gatewayUrl);
    const command = invoke;
    const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();

    // Environments: W (terminal only), U (terminal and agent), T (terminal,
    // agent and the load as hidden tabs), and the background agents.
    progress("creating environments");
    const hiddenLoadTabs = [
      ...Array.from({ length: LOAD.build }, (_, index) => `echo-build-${index}`),
      ...Array.from({ length: LOAD.tool }, (_, index) => `echo-tool-${index}`),
    ];
    const terminalOnly = await createEnvironment(invoke, fixture!, "w");
    const withAgent = await createEnvironment(invoke, fixture!, "u");
    const withHidden = await createEnvironment(invoke, fixture!, "t");
    created.push(terminalOnly, withAgent, withHidden);
    await seedLayout(invoke, terminalOnly.id, terminalLeaf([]));
    await seedLayout(invoke, withAgent.id, split([terminalLeaf([]), agentLeaf(withAgent.id)]));
    await seedLayout(
      invoke,
      withHidden.id,
      split([terminalLeaf(hiddenLoadTabs), agentLeaf(withHidden.id)]),
    );
    const backgroundAgents: Environment[] = [];
    for (let index = 0; index < Math.max(0, LOAD.agents - 2); index += 1) {
      const environment = await createEnvironment(invoke, fixture!, `a${index}`);
      created.push(environment);
      await seedLayout(invoke, environment.id, agentLeaf(environment.id));
      backgroundAgents.push(environment);
    }
    const agentEnvironments = [withAgent, withHidden, ...backgroundAgents].slice(0, LOAD.agents);

    // Load sessions: the hidden tabs' own, and the same shape under keys no
    // tab has, in the terminal-only environment (never subscribed by a page).
    const typing = new Map<string, string>();
    for (const environment of [terminalOnly, withAgent, withHidden]) {
      typing.set(environment.id, await terminalSession(invoke, environment.id, TYPING_TAB));
    }
    const hiddenSessions = [];
    for (const tab of hiddenLoadTabs)
      hiddenSessions.push(await terminalSession(invoke, withHidden.id, tab));
    const unseenSessions = [];
    for (const tab of hiddenLoadTabs) {
      unseenSessions.push(await terminalSession(invoke, terminalOnly.id, `unseen-${tab}`));
    }
    const bun = bunPath();
    const loadCommands = hiddenLoadTabs.map((tab) =>
      tab.startsWith("echo-build")
        ? `clear; ${bun} ${PRODUCER} build ${LOAD.buildBytesPerSecond}\n`
        : `clear; ${bun} ${PRODUCER} tool ${LOAD.toolBurstBytes} ${LOAD.toolEveryMs}\n`,
    );
    for (const sessionId of typing.values()) {
      await invoke("local_terminal_write", {
        sessionId,
        data: "clear; stty raw -echo && exec cat\n",
      });
    }

    await measured.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(measured, fixture!.name);

    // One driver page per agent, each only ever on its own environment. It
    // opens the agent to send a prompt and then leaves for a blank page, so
    // only the measured page renders the transcripts.
    const drivers = new Map<string, Page>();
    for (const environment of agentEnvironments)
      drivers.set(environment.id, await signedInPage(1280));
    const prompt = async (environment: Environment, text: string) => {
      const driver = drivers.get(environment.id)!;
      await driver.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
      await dismissStartupDialogs(driver, fixture!.name);
      await selectEnvironment(driver, environment);
      await expect(composer(driver)).toBeEditable({ timeout: 180_000 });
      await sendPrompt(driver, text);
    };

    // Warm every agent once, so a measured run never waits on a CLI cold start.
    progress("warming the agents");
    for (const environment of agentEnvironments) {
      await prompt(environment, `ECHOWARM${environment.id.slice(0, 6)}`);
    }
    for (const environment of agentEnvironments) {
      await expect
        .poll(
          () =>
            model
              .callsWith(`ECHOWARM${environment.id.slice(0, 6)}`)
              .some((call) => call.answeredAt),
          {
            timeout: 180_000,
          },
        )
        .toBe(true);
    }

    let turn = 0;
    const startAgents = async () => {
      const words: string[] = [];
      for (const environment of agentEnvironments) {
        turn += 1;
        const word = `ECHOLOAD${turn}X`;
        await prompt(environment, `${word} [stream:${STREAM_DELTAS}]`);
        words.push(word);
      }
      for (const word of words) {
        await expect
          .poll(() => model.callsWith(word).some((call) => call.answeredAt), { timeout: 120_000 })
          .toBe(true);
      }
      for (const driver of drivers.values()) await driver.goto("about:blank");
      return words;
    };
    const startTerminals = async (sessions: string[]) => {
      for (const [index, sessionId] of sessions.entries()) {
        await command("local_terminal_write", { sessionId, data: loadCommands[index] });
      }
    };
    const stopTerminals = async (sessions: string[]) => {
      for (const sessionId of sessions) {
        await command("local_terminal_write", { sessionId, data: "\u0003" });
      }
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      // Rotate the order so host drift does not always favour one variant.
      const order = VARIANTS.map((_, index) => VARIANTS[(index + round) % VARIANTS.length]!);
      for (const variant of order) {
        const hiddenTabs = variant === "hidden-tabs" || variant === "hidden-tabs-direct";
        const environment = hiddenTabs
          ? withHidden
          : variant === "agent-visible"
            ? withAgent
            : terminalOnly;
        const loaded = variant !== "idle";
        const loadSessions = hiddenTabs ? hiddenSessions : unseenSessions;
        progress(`round ${round + 1}: ${variant}`);
        let words: string[] = [];
        if (loaded) words = await startAgents();
        // Pass through the terminal-only environment, so the target's
        // terminals mount afresh and read the measurement switch.
        if (environment !== terminalOnly) await openEnvironment(measured, terminalOnly, false);
        await measured.evaluate(
          ([key, direct]) => {
            if (direct) localStorage.setItem(key, "off");
            else localStorage.removeItem(key);
          },
          [BACKGROUND_WRITES_KEY, variant === "hidden-tabs-direct"] as const,
        );
        await openEnvironment(measured, environment, environment !== terminalOnly);
        if (loaded) await startTerminals(loadSessions);
        // Let the load reach a steady state and the page settle after the switch.
        await measured.waitForTimeout(loaded ? 4_000 : 2_000);
        const loopBefore = await backendLoop(measured, gatewayUrl);
        const startedAt = Date.now();
        const result = await typeAndTime(measured, typing.get(environment.id)!);
        const endedAt = Date.now();
        const loopAfter = await backendLoop(measured, gatewayUrl);
        if (loaded) await stopTerminals(loadSessions);
        const agentsStreamedThroughout = words.every((word) =>
          model.callsWith(word).some((call) => !call.streamedAt || call.streamedAt >= endedAt),
        );
        const cell = {
          variant,
          round: round + 1,
          durationMs: endedAt - startedAt,
          agentsStreamedThroughout,
          ...result,
          backendEventLoop: loopDelta(loopBefore, loopAfter),
        };
        evidence.cells.push(cell);
        progress(
          `${variant}: p50 ${result.keyToEchoMs.p50} p95 ${result.keyToEchoMs.p95} p99 ${result.keyToEchoMs.p99} ms, timeouts ${result.keyToEchoMs.timeouts}`,
        );
        test.info().annotations.push({ type: variant, description: JSON.stringify(cell) });
        if (loaded) {
          // Let the turns end, so the next variant starts from the same place.
          await expect
            .poll(
              () => words.every((word) => model.callsWith(word).some((call) => call.streamedAt)),
              {
                timeout: STREAM_DELTAS * 25 + 120_000,
              },
            )
            .toBe(true);
          await measured.waitForTimeout(3_000);
        }
      }
    }
    for (const cell of evidence.cells) {
      expect((cell.keyToEchoMs as { samples: number }).samples, "keys echoed").toBeGreaterThan(0);
    }
  } finally {
    for (const environment of created) {
      if (!invoke) break;
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    for (const context of contexts) await context.close().catch(() => undefined);
  }
});

/**
 * The no-drop check for idle-time writes: a hidden tab prints a long numbered
 * run while the typing tab is shown, and once revealed its screen must end
 * with the run's last numbers, in order. Only numbers are compared.
 */
test("a hidden tab shows every line once revealed", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const status = readyStatus();
  const gatewayUrl = status.browserUrl!;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let invoke: Invoke | undefined;
  let environment: Environment | undefined;
  try {
    await fetchModulesOutsideChromium(context);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const login = new URL(mintLoginUrl());
    await page.goto(new URL(`${login.pathname}${login.search}`, gatewayUrl).href, {
      waitUntil: "domcontentloaded",
    });
    invoke = invokeThrough(page, gatewayUrl);
    const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    environment = await createEnvironment(invoke, fixture!, "reveal");
    const hiddenTab = "echo-reveal";
    await seedLayout(invoke, environment.id, terminalLeaf([hiddenTab]));
    await terminalSession(invoke, environment.id, TYPING_TAB);
    const hidden = await terminalSession(invoke, environment.id, hiddenTab);
    await page.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page, fixture!.name);
    await openEnvironment(page, environment, false);
    await page.evaluate((key) => localStorage.removeItem(key), BACKGROUND_WRITES_KEY);
    const last = 150_000;
    await invoke("local_terminal_write", { sessionId: hidden, data: `clear; seq 1 ${last}\n` });
    // Give the run time to finish while the tab is still hidden.
    await page.waitForTimeout(8_000);
    await page.locator(`[id="pane-tab:${environment.id}:echo-terminal-pane:${hiddenTab}"]`).click();
    await expect
      .poll(
        () =>
          page.evaluate((tabId) => {
            const rows = document.querySelector(`[data-terminal-tab-id="${tabId}"] .xterm-rows`);
            const lines = Array.from(rows?.children ?? [])
              .map((row) => (row.textContent ?? "").trim())
              .filter((line) => /^\d+$/u.test(line))
              .map(Number);
            if (lines.length < 10) return `only ${lines.length} numbered rows`;
            for (let index = 1; index < lines.length; index += 1) {
              if (lines[index] !== lines[index - 1]! + 1) return "rows out of order";
            }
            return lines.at(-1);
          }, hiddenTab),
        { timeout: 60_000 },
      )
      .toBe(last);
  } finally {
    if (invoke && environment) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    await context.close().catch(() => undefined);
  }
});

async function sendPrompt(page: Page, prompt: string) {
  const box = composer(page);
  await box.fill(prompt);
  const button = page
    .getByTestId("shared-native-compose-bar")
    .getByRole("button", { name: "Send", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await box.press("Enter");
  await expect(box).toHaveText("", { timeout: 30_000 });
}
