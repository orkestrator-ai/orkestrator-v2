/**
 * The single-host remote bandwidth matrix (to-do 0052 (retired) task 2; results and
 * decisions in docs/development/remote-bandwidth.md):
 * several real browser clients on one Claude session and one environment's
 * terminals, against a real `dev:test` gateway, per compression mode
 * (`body`, `on`), terminal transport (shared SSE stream, opt-in WebSocket)
 * and link (loopback, and a slow link shaped in each client's loopback
 * relay).
 *
 * The provider is the profile's real Claude CLI and bridge sent to a loopback
 * Anthropic endpoint (`fake-anthropic-model.ts`) through the profile's own
 * isolated `CLAUDE_CONFIG_DIR`, so nothing is billed and no real Claude home
 * is read. A `[stream:<n>]` prompt streams `n` lines at 25 ms, so the
 * transcript is patched many times while every client watches.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_REMOTE_BANDWIDTH=1`). It restarts the
 * profile once per compression mode (`ORKESTRATOR_GATEWAY_COMPRESSION`), so
 * run it alone against a credential-free profile of its own:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile rbw52 --fixture --no-agent-credentials --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=rbw52 ORKESTRATOR_AGENT_TEST_LIVE_REMOTE_BANDWIDTH=1 \
 *   ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT=43252 \
 *     mise run test:logged -- --name remote-bandwidth -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     remote-bandwidth-live.spec.ts --workers=1
 *
 * Each client reaches the gateway through its own loopback link
 * (`remote-bandwidth-meter.ts`), which counts the exact wire bytes per request
 * class and, for the slow-link cells, shapes the link (rate and one-way
 * latency) in both directions. Setup invokes and `/metrics` reads go straight
 * to the gateway URL, so they bypass every relay and are never counted or
 * slowed. Gateway `/metrics` deltas over each cell are recorded too; its
 * gzip figures cover browser listeners only, while its stream totals also
 * include the profile's own headless Electron window (control listener,
 * always identity). Latency is a wall-clock interval in this process.
 * Evidence holds only numbers and cell labels, never prompts, terminal
 * output, tokens or URLs.
 *
 * Each cell is checked as it is recorded (`remote-bandwidth-qualification.ts`):
 * it needs every sample it was meant to take, every terminal burst finished
 * and settled, and each budgeted p95 inside its budget. A cell that falls
 * short is still recorded, with its outcome and reasons, and the test fails
 * once its run is over.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import { devTestRestartArgs, type StoredProfileSelection } from "./profile-restart-args";
import {
  linkDelta,
  numericDelta,
  startCountingLink,
  type CountingLink,
  type LinkTotals,
} from "./remote-bandwidth-meter";
import {
  completionAfterLastDelta,
  lastStreamByteMs,
  latencyProblems,
  outcomeOf,
  summary,
  terminalProblems,
  type Problem,
} from "./remote-bandwidth-qualification";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Mode = "body" | "on";
type Transport = "sse" | "websocket";
type Link = { label: "loopback" | "throttled"; kbps?: number; latencyMs?: number };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "rbw52";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_REMOTE_BANDWIDTH === "1";
const FAKE_MODEL_PORT = Number(process.env.ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT ?? "0");
const MODES = (process.env.ORKESTRATOR_AGENT_TEST_BANDWIDTH_MODES ?? "on,body")
  .split(",")
  .map((mode) => mode.trim())
  .filter((mode): mode is Mode => mode === "body" || mode === "on");
/** Which parts run: the transport matrix, the data-saving cells (in `on` mode), or both. */
const PARTS = new Set(
  (process.env.ORKESTRATOR_AGENT_TEST_BANDWIDTH_PARTS ?? "matrix,data-saving")
    .split(",")
    .map((part) => part.trim()),
);
const CLIENTS = Math.max(2, Number(process.env.ORKESTRATOR_AGENT_TEST_BANDWIDTH_CLIENTS ?? "3"));
const ROUNDS = Math.max(1, Number(process.env.ORKESTRATOR_AGENT_TEST_BANDWIDTH_ROUNDS ?? "3"));
const IDLE_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_BANDWIDTH_IDLE_MS ?? "20000");
/** Lines per streamed answer: 25 ms apart, so a turn streams for about five seconds. */
const STREAM_LINES = 200;
/**
 * The slow link: the in-process baseline's constrained run (512 kbit/s of
 * 1,000 bits, as `remote-bandwidth-throttle.ts` counts them, and 40 ms each
 * way). The relay shapes both directions; the baseline shapes only the
 * downstream rate.
 */
const LINKS: Link[] = [{ label: "loopback" }, { label: "throttled", kbps: 512, latencyMs: 40 }];
const TRANSPORTS: Transport[] = ["sse", "websocket"];
const AGENT_TAB = "rbw-claude";
const TERMINAL_TAB = "rbw-term";
const HIDDEN_TERMINAL_TAB = "rbw-term-hidden";
/** recurring-work.md "Latency budgets": approval 2 s p95, completion 3 s p95. */
const COMPLETION_BUDGET_MS = 3_000;
const APPROVAL_BUDGET_MS = 2_000;

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_REMOTE_BANDWIDTH=1 against a disposable profile");

// ---------------------------------------------------------------------------
// Profile lifecycle

function runtime() {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(`dev:status for "${profile}" returned no manifest`);
  return JSON.parse(command.stdout) as Status;
}

function readyStatus(): Status {
  const status = profileStatus();
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

function runAsync(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * Stops the profile and starts it again with the selection in its
 * `profile.json` and the given compression mode. `--fixture` is not passed
 * back: it would recreate the repository every worktree points at.
 */
async function restartProfile(mode: Mode): Promise<Status> {
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime().profileRoot, "profile.json"), "utf8"),
  ) as StoredProfileSelection;
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const output = openSync(test.info().outputPath(`dev-test-restart-${mode}.log`), "a");
  const launcher = spawn("bun", [...devTestRestartArgs(profile, stored), "--headless"], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...outlivingProcessEnv(),
      ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
      ORKESTRATOR_GATEWAY_COMPRESSION: mode,
    },
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  let status: Status | undefined;
  await expect
    .poll(
      () => {
        status = profileStatus();
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [500] },
    )
    .toBe(true);
  return status!;
}

// ---------------------------------------------------------------------------
// Clients

type Client = {
  label: string;
  context: BrowserContext;
  page: Page;
  link: CountingLink;
};

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

/**
 * Sets the client's persisted preferences on the gateway origin, for the
 * next load to read: the terminal transport key the gateway client reads, and
 * `dataSaving` in the browser's `ui-storage` record (merged, so other fields
 * stay).
 */
async function setPreferences(
  page: Page,
  preferences: { transport: Transport; dataSaving: boolean },
) {
  await page.evaluate((wanted) => {
    if (wanted.transport === "websocket") {
      localStorage.setItem("orkestrator-terminal-transport", "websocket");
    } else localStorage.removeItem("orkestrator-terminal-transport");
    let record: { state?: Record<string, unknown>; version?: number } = {};
    try {
      record = JSON.parse(localStorage.getItem("ui-storage") ?? "{}");
    } catch {
      record = {};
    }
    localStorage.setItem(
      "ui-storage",
      JSON.stringify({
        ...record,
        state: { ...record.state, dataSaving: wanted.dataSaving },
        version: record.version ?? 0,
      }),
    );
  }, preferences);
}

async function newClient(browser: Browser, label: string, status: Status): Promise<Client> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fetchModulesOutsideChromium(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const link = await startCountingLink(status.browserUrl!);
  const login = new URL(mintLoginUrl());
  const response = await page.goto(new URL(`${login.pathname}${login.search}`, link.url).href, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok() ?? false, `${label}: sign-in`).toBe(true);
  return { label, context, page, link };
}

async function closeClient(client: Client | undefined): Promise<void> {
  await client?.context.close().catch(() => undefined);
  await client?.link.close().catch(() => undefined);
}

function applyLink(client: Client, link: Link): void {
  client.link.shape({ kbps: link.kbps, latencyMs: link.latencyMs });
}

/** Invokes straight on the gateway URL: not through any client's relay, so never counted or shaped. */
function invokeThrough(page: Page, gatewayUrl: string): Invoke {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", gatewayUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command}: HTTP ${response.status()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

type GatewayMetrics = {
  stream?: Record<string, unknown>;
  compression?: Record<string, unknown> & { configuredMode?: string };
  terminalWebSocket?: Record<string, unknown>;
  events?: Record<string, Record<string, unknown>>;
};

async function gatewayMetrics(page: Page, gatewayUrl: string): Promise<GatewayMetrics> {
  // Straight to the gateway URL through Playwright's request context, so the
  // read bypasses every client's relay: it is neither counted nor shaped.
  const response = await page.request.get(new URL("/__orkestrator/metrics", gatewayUrl).href);
  expect(response.ok(), `metrics: HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as GatewayMetrics;
}

function sumEvents(metrics: GatewayMetrics): { frames: number; serializedBytes: number } {
  let frames = 0;
  let serializedBytes = 0;
  for (const entry of Object.values(metrics.events ?? {})) {
    frames += Number(entry.frames ?? 0);
    serializedBytes += Number(entry.serializedBytes ?? 0);
  }
  return { frames, serializedBytes };
}

/** What the gateway did over a cell: encoded and serialized bytes, compressors, sockets. */
function gatewayDelta(before: GatewayMetrics, after: GatewayMetrics) {
  const events = { before: sumEvents(before), after: sumEvents(after) };
  return {
    stream: numericDelta(before.stream, after.stream),
    eventFrames: events.after.frames - events.before.frames,
    eventSerializedBytes: events.after.serializedBytes - events.before.serializedBytes,
    compression: {
      ...numericDelta(before.compression, after.compression),
      streamingActive: after.compression?.streamingActive,
      streamingPeakActive: after.compression?.streamingPeakActive,
    },
    terminalWebSocket: {
      ...numericDelta(before.terminalWebSocket, after.terminalWebSocket),
      open: after.terminalWebSocket?.open,
      channelsOpen: after.terminalWebSocket?.channelsOpen,
      peakQueuedBytes: after.terminalWebSocket?.peakQueuedBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// The environment under test

function composer(page: Page) {
  return page
    .getByTestId("shared-native-compose-bar")
    .getByRole("textbox", { name: /^Message Claude/ });
}

/** Opens the environment's row; the seeded layout shows the Claude tab beside two terminals. */
async function openEnvironment(page: Page, fixtureName: string, environmentName: string) {
  const expand = page.getByRole("button", { name: `Expand project ${fixtureName}` });
  const entry = page.getByText(environmentName, { exact: true }).first();
  const dialog = page.getByRole("alertdialog");
  // The fake key is not a Claude login, so the startup check reports none.
  let quietSince = Date.now();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const label of [
      "Continue Without Docker",
      "Continue Without GitHub CLI",
      "Continue Without Claude",
    ]) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.isVisible()) await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    if (await dialog.first().isVisible()) quietSince = Date.now();
    else if (!(await expand.or(entry).first().isVisible())) quietSince = Date.now();
    else if (Date.now() - quietSince >= 2_000) break;
    await page.waitForTimeout(200);
  }
  await expect(dialog.first()).toBeHidden({ timeout: 5_000 });
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
  await expect(composer(page)).toBeVisible({ timeout: 90_000 });
}

async function seedLayout(invoke: Invoke, environmentId: string): Promise<void> {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "rbw-agent-pane",
      root: {
        kind: "split",
        id: "rbw-split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 0,
        children: [
          {
            kind: "leaf",
            id: "rbw-agent-pane",
            activeTabId: AGENT_TAB,
            tabs: [
              {
                id: AGENT_TAB,
                type: "agent-native",
                displayTitle: "Bandwidth qualification",
                nativeAgentData: { environmentId, platform: "claude", isLocal: true },
                initialAgentModel: "haiku",
              },
            ],
          },
          {
            kind: "leaf",
            id: "rbw-terminal-pane",
            activeTabId: TERMINAL_TAB,
            tabs: [
              { id: TERMINAL_TAB, type: "plain" },
              { id: HIDDEN_TERMINAL_TAB, type: "plain" },
            ],
          },
        ],
      },
    },
  });
}

async function createEnvironment(
  invoke: Invoke,
  fixture: Project,
  agentSettings?: Record<string, unknown>,
): Promise<Environment> {
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `rbw-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
    ...(agentSettings ? { agentSettings } : {}),
  });
  await invoke("start_environment", { environmentId: created.id });
  await expect
    .poll(
      async () =>
        (await invoke<Environment>("get_environment", { environmentId: created.id })).status,
      { timeout: 120_000 },
    )
    .toBe("running");
  await seedLayout(invoke, created.id);
  return invoke<Environment>("get_environment", { environmentId: created.id });
}

/** The backend-owned session behind a terminal tab (its key is the tab id). */
async function terminalSession(
  invoke: Invoke,
  environmentId: string,
  tabId: string,
): Promise<string> {
  const created = await invoke<{ sessionId: string } | string>("create_local_terminal_session", {
    environmentId,
    cols: 120,
    rows: 30,
    trackEnvironmentActivity: false,
    terminalKey: tabId,
  });
  const sessionId = typeof created === "string" ? created : created.sessionId;
  await invoke("start_local_terminal_session", { sessionId }).catch(() => undefined);
  return sessionId;
}

// ---------------------------------------------------------------------------
// Measurement

type Cell = Record<string, unknown>;
const evidence: { run: Record<string, unknown>; cells: Cell[] } = {
  run: {},
  cells: [],
};
/** What the current test's cells fell short on; the test fails on any at its end. */
let shortfalls: string[] = [];

/**
 * One line per step, so a logged runner's no-output watchdog sees a long case
 * making progress. Labels only, never content.
 */
function progress(step: string): void {
  console.log(`[remote-bandwidth] ${new Date().toISOString()} ${step}`);
}

function record(cell: Cell, problems: Problem[] = []): void {
  const label = `${String(cell.cell)} ${String(cell.mode)}/${String(cell.transport)}/${String(cell.link)}`;
  const checked = {
    ...cell,
    outcome: outcomeOf(problems),
    problems: problems.map((problem) => problem.detail),
  };
  evidence.cells.push(checked);
  for (const problem of problems) shortfalls.push(`${label}: ${problem.detail}`);
  progress(`recorded ${label} (${checked.outcome})`);
  test.info().annotations.push({ type: String(cell.cell), description: JSON.stringify(checked) });
}

function snapshots(clients: Client[]): LinkTotals[] {
  return clients.map((client) => {
    client.link.resetPeak();
    return client.link.snapshot();
  });
}

function perClient(clients: Client[], before: LinkTotals[], elapsedMs: number) {
  return clients.map((client, index) => {
    const after = client.link.snapshot();
    const delta = linkDelta(before[index]!, after);
    return {
      client: client.label,
      ...delta,
      peakQueuedBytes: after.peakQueuedBytes,
      downKiBPerMinute: Number(((delta.downBytes / 1024) * (60_000 / elapsedMs)).toFixed(1)),
    };
  });
}

/** Waits until no client has received a streamed byte for `quietMs`. */
async function streamsQuiet(clients: Client[], quietMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = Math.max(...clients.map((client) => client.link.snapshot().lastStreamDelivery));
    if (Date.now() - latest >= quietMs) return { quiet: true };
    if (Date.now() > deadline) return { quiet: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function msUntil(since: number, done: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return Date.now() - since;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Whether one transcript row holds every needle: one message, so a needle an
 * earlier answer also carries (a streamed answer's invariant last line) never
 * completes the current one.
 */
async function transcriptHas(page: Page, ...needles: string[]): Promise<boolean> {
  return page
    .evaluate((wanted) => {
      for (const row of Array.from(document.querySelectorAll("[data-chat-message-index]"))) {
        const text = row.textContent ?? "";
        if (wanted.every((needle) => text.includes(needle))) return true;
      }
      return false;
    }, needles)
    .catch(() => false);
}

async function send(page: Page, prompt: string): Promise<number> {
  const box = composer(page);
  await box.fill(prompt);
  const button = page
    .getByTestId("shared-native-compose-bar")
    .getByRole("button", { name: "Send", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  const sentAt = Date.now();
  await box.press("Enter");
  await expect(box).toHaveText("", { timeout: 30_000 });
  return sentAt;
}

function tag(prefix: string): string {
  return `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`;
}

/** Commands whose output is fixture text only: a redundant build log and random printable bytes. */
// The done marker is printed as `RBWDONE-<tag>`, which the echoed command line
// (`RBWDONE <tag>`) never contains, so it shows only once the command ran.
const BURSTS = {
  build: (tagged: string) =>
    `for i in $(seq 1 4000); do echo "[build] compiling src/module-$((i % 37)).ts ... ok ($((i % 113)) ms) package-$((i % 11))"; done; printf '%s-%s\\n' RBWDONE ${tagged}\n`,
  incompressible: (tagged: string) =>
    `head -c 150000 /dev/urandom | base64 -w 100; printf '%s-%s\\n' RBWDONE ${tagged}\n`,
} as const;

// ---------------------------------------------------------------------------
// Fixture

let model: FakeAnthropicModel;
let settingsPath: string;
let priorSettings: string | null = null;

function sameJson(first: string | null, second: string): boolean {
  try {
    return (
      first !== null && JSON.stringify(JSON.parse(first)) === JSON.stringify(JSON.parse(second))
    );
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  model = await startFakeAnthropicModel(FAKE_MODEL_PORT);
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  evidence.run = {
    profile,
    parts: [...PARTS],
    clients: CLIENTS,
    rounds: ROUNDS,
    idleMs: IDLE_MS,
    streamLines: STREAM_LINES,
    links: LINKS,
    commit: spawnSync("git", ["rev-parse", "--short=9", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim(),
    startedAt: new Date().toISOString(),
  };
});

test.afterAll(async () => {
  await fs.writeFile(
    path.join(test.info().outputDir, "..", `evidence-remote-bandwidth-${Date.now()}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else if (!sameJson(priorSettings, readFileSync(settingsPath, "utf8")))
      await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

/**
 * Brings the profile up in `mode` with the fake model's settings, restarting
 * only when either differs, so no Claude process keeps an old endpoint.
 */
async function profileIn(browser: Browser, mode: Mode): Promise<Status> {
  const settings = JSON.stringify(fakeModelClaudeSettings(model.origin));
  let status = readyStatus();
  const current = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const probe = await newClient(browser, "probe", status);
  let running: string | undefined;
  try {
    running = (await gatewayMetrics(probe.page, status.browserUrl!)).compression?.configuredMode;
  } finally {
    await closeClient(probe);
  }
  if (!sameJson(current, settings) || running !== mode) {
    progress(`restarting the profile in ${mode} mode`);
    await fs.writeFile(settingsPath, settings);
    status = await restartProfile(mode);
  }
  return status;
}

for (const mode of MODES) {
  test(`matrix in ${mode} mode`, async ({ browser }) => {
    test.setTimeout(45 * 60_000);
    shortfalls = [];
    const status = await profileIn(browser, mode);
    const clients: Client[] = [];
    let invoke: Invoke | undefined;
    let environment: Environment | undefined;
    let askEnvironment: Environment | undefined;
    try {
      for (let index = 0; index < CLIENTS; index += 1) {
        clients.push(await newClient(browser, `client-${index + 1}`, status));
      }
      const gatewayUrl = status.browserUrl!;
      const setup = clients[0]!;
      invoke = invokeThrough(setup.page, gatewayUrl);
      const command: Invoke = invoke;
      const metrics = () => gatewayMetrics(setup.page, gatewayUrl);
      expect((await metrics()).compression?.configuredMode, "the gateway runs this mode").toBe(
        mode,
      );
      const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === testProject,
      );
      expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
      environment = await createEnvironment(invoke, fixture!);
      const visibleTerminal = await terminalSession(invoke, environment.id, TERMINAL_TAB);
      const hiddenTerminal = await terminalSession(invoke, environment.id, HIDDEN_TERMINAL_TAB);

      for (const transport of PARTS.has("matrix") ? TRANSPORTS : []) {
        progress(`opening ${CLIENTS} clients on ${transport}`);
        for (const client of clients) {
          await setPreferences(client.page, { transport, dataSaving: false });
          applyLink(client, LINKS[0]!);
          await client.page.goto(client.link.url, { waitUntil: "domcontentloaded" });
          await openEnvironment(client.page, fixture!.name, environment.name);
        }
        // Let every client finish its first reads before measuring.
        await clients[0]!.page.waitForTimeout(3_000);
        for (const link of LINKS) {
          for (const client of clients) applyLink(client, link);
          const base = { mode, transport, link: link.label, clients: CLIENTS };

          // Idle: an open session and two terminals, nothing happening.
          {
            const before = snapshots(clients);
            const server = await metrics();
            const startedAt = Date.now();
            await clients[0]!.page.waitForTimeout(IDLE_MS);
            const elapsed = Date.now() - startedAt;
            record({
              cell: "idle",
              ...base,
              elapsedMs: elapsed,
              perClient: perClient(clients, before, elapsed),
              gateway: gatewayDelta(server, await metrics()),
            });
          }

          // Agent turn: one client prompts; every client watches the transcript patches.
          {
            const firstUpdate: Array<number | null> = [];
            const completion: Array<number | null> = [];
            const before = snapshots(clients);
            const server = await metrics();
            const startedAt = Date.now();
            for (let round = 0; round < ROUNDS; round += 1) {
              const word = tag("RBW");
              const prompt = `${word} [stream:${STREAM_LINES}]`;
              await send(clients[0]!.page, prompt);
              await expect
                .poll(() => model.callsWith(word).some((call) => call.answeredAt), {
                  timeout: 60_000,
                })
                .toBe(true);
              const answeredAt = model.callsWith(word).find((call) => call.answeredAt)!.answeredAt!;
              // The current answer's own row: its first line names this
              // round's word, and its last line is the same in every round.
              const answer = `Answer to: ${word}`;
              const lastLine = `step ${STREAM_LINES} of ${STREAM_LINES}`;
              const results = await Promise.all(
                clients.map(async (client) => {
                  const first = await msUntil(answeredAt, () => transcriptHas(client.page, answer));
                  const done = await msUntil(answeredAt, () =>
                    transcriptHas(client.page, answer, lastLine),
                  );
                  return { first, doneAt: done === null ? null : answeredAt + done };
                }),
              );
              // This round's own stream end; a stream that never ended leaves completion unknown.
              await msUntil(
                Date.now(),
                async () => model.callsWith(word).some((call) => call.streamedAt),
                10_000,
              );
              const streamedAt = model.callsWith(word).find((call) => call.streamedAt)?.streamedAt;
              for (const result of results) {
                firstUpdate.push(result.first);
                completion.push(completionAfterLastDelta(result.doneAt, streamedAt));
              }
              await expect(composer(clients[0]!.page)).toBeEditable({ timeout: 60_000 });
            }
            const elapsed = Date.now() - startedAt;
            const firstUpdateMs = summary(firstUpdate);
            const completionMs = summary(completion);
            record(
              {
                cell: "agent-turn",
                ...base,
                rounds: ROUNDS,
                elapsedMs: elapsed,
                firstUpdateMs,
                completionAfterLastDeltaMs: { ...completionMs, budgetMs: COMPLETION_BUDGET_MS },
                perClient: perClient(clients, before, elapsed),
                gateway: gatewayDelta(server, await metrics()),
              },
              [
                ...latencyProblems("first update", firstUpdateMs, { samples: ROUNDS * CLIENTS }),
                ...latencyProblems("completion", completionMs, {
                  samples: ROUNDS * CLIENTS,
                  budgetMs: COMPLETION_BUDGET_MS,
                }),
              ],
            );
          }

          // Terminal bursts: visible and background tab, redundant and random output.
          for (const [burst, terminal] of [
            ["build", visibleTerminal],
            ["build-hidden-tab", hiddenTerminal],
            ["incompressible", visibleTerminal],
          ] as const) {
            await streamsQuiet(clients, 1_000, 30_000);
            const tagged = tag("RBW");
            const before = snapshots(clients);
            const server = await metrics();
            const startedAt = Date.now();
            await invoke("local_terminal_write", {
              sessionId: terminal,
              data: BURSTS[burst === "incompressible" ? "incompressible" : "build"](tagged),
            });
            // The backend's own snapshot says when the command finished.
            const backendDoneMs = await msUntil(
              startedAt,
              async () =>
                (
                  await command<{ output: string }>("get_terminal_output_snapshot", {
                    sessionId: terminal,
                  })
                ).output.includes(`RBWDONE-${tagged}`),
              120_000,
            );
            const quiet = await streamsQuiet(clients, 1_500, 120_000);
            const lastDeliveries = clients.map((client) =>
              lastStreamByteMs(startedAt, client.link.snapshot().lastStreamDelivery),
            );
            const elapsed = Date.now() - startedAt;
            const lastByte = summary(lastDeliveries);
            record(
              {
                cell: `terminal-${burst}`,
                ...base,
                backendDoneMs,
                settled: quiet.quiet,
                elapsedMs: elapsed,
                lastStreamByteMs: lastByte,
                perClient: perClient(clients, before, elapsed),
                gateway: gatewayDelta(server, await metrics()),
              },
              terminalProblems(
                `terminal-${burst}`,
                { backendDoneMs, settled: quiet.quiet, lastStreamByteMs: lastByte },
                CLIENTS,
              ),
            );
          }
        }
      }

      // Data saving (task 6): one client with it on, one with it off, on the
      // default mode and transport, loopback.
      if (mode === "on" && PARTS.has("data-saving")) {
        const [normal, saving] = clients as [Client, Client];
        const pair = [normal, saving];
        // An "ask" policy, so a tool call parks an approval both clients see.
        askEnvironment = await createEnvironment(invoke, fixture!, {
          executionPolicy: { approvals: "ask" },
        });
        for (const client of pair) {
          await setPreferences(client.page, {
            transport: "sse",
            dataSaving: client === saving,
          });
          applyLink(client, LINKS[0]!);
          await client.page.goto(client.link.url, { waitUntil: "domcontentloaded" });
          await openEnvironment(client.page, fixture!.name, askEnvironment.name);
        }
        for (const client of clients.slice(2)) await client.page.goto("about:blank");
        await normal.page.waitForTimeout(3_000);
        const base = { mode, transport: "sse", link: "loopback" };
        // A running turn held at "the provider is working" for 30 s.
        {
          const word = tag("RBWHOLD");
          const hold = word.toLowerCase();
          await send(normal.page, `${word} [hold:${hold}]`);
          await expect.poll(() => model.held().includes(hold), { timeout: 60_000 }).toBe(true);
          await normal.page.waitForTimeout(2_000);
          const before = snapshots(pair);
          const startedAt = Date.now();
          await normal.page.waitForTimeout(30_000);
          const elapsed = Date.now() - startedAt;
          record({
            cell: "data-saving-running",
            ...base,
            elapsedMs: elapsed,
            perClient: perClient(pair, before, elapsed).map((entry, index) => ({
              ...entry,
              dataSaving: index === 1,
            })),
          });
          model.release(hold);
          await expect(composer(normal.page)).toBeEditable({ timeout: 60_000 });
        }
        // Idle native view.
        {
          await normal.page.waitForTimeout(5_000);
          const before = snapshots(pair);
          const startedAt = Date.now();
          await normal.page.waitForTimeout(30_000);
          const elapsed = Date.now() - startedAt;
          record({
            cell: "data-saving-idle",
            ...base,
            elapsedMs: elapsed,
            perClient: perClient(pair, before, elapsed).map((entry, index) => ({
              ...entry,
              dataSaving: index === 1,
            })),
          });
        }
        // The Files panel's All files tab open beside the idle view on a
        // watched worktree (its Changes tab is event driven and never polls);
        // the idle cell above is the same view without it.
        {
          for (const client of pair) {
            const show = client.page.getByRole("button", { name: "Show file panel" });
            if (await show.isVisible()) await show.click();
            await expect(
              client.page.getByRole("button", { name: "Hide file panel" }),
            ).toBeVisible();
            await client.page.getByRole("tab", { name: "All files", exact: true }).click();
          }
          await normal.page.waitForTimeout(5_000);
          const before = snapshots(pair);
          const startedAt = Date.now();
          await normal.page.waitForTimeout(60_000);
          const elapsed = Date.now() - startedAt;
          record({
            cell: "data-saving-files-panel-all-files",
            ...base,
            elapsedMs: elapsed,
            perClient: perClient(pair, before, elapsed).map((entry, index) => ({
              ...entry,
              dataSaving: index === 1,
            })),
          });
          for (const client of pair) {
            await client.page.getByRole("button", { name: "Hide file panel" }).click();
          }
        }
        // Completion latency with and without data saving.
        {
          const latency: Record<"off" | "on", Array<number | null>> = { off: [], on: [] };
          const rounds = Math.max(ROUNDS, 5);
          for (let round = 0; round < rounds; round += 1) {
            const word = tag("RBWEND");
            const hold = word.toLowerCase();
            await send(normal.page, `${word} [hold:${hold}]`);
            await expect.poll(() => model.held().includes(hold), { timeout: 60_000 }).toBe(true);
            await normal.page.waitForTimeout(1_500);
            const releasedAt = Date.now();
            model.release(hold);
            const [off, on] = await Promise.all(
              pair.map((client) =>
                msUntil(releasedAt, () => transcriptHas(client.page, `Answer to: ${word}`)),
              ),
            );
            latency.off.push(off ?? null);
            latency.on.push(on ?? null);
            await expect(composer(normal.page)).toBeEditable({ timeout: 60_000 });
          }
          const offMs = summary(latency.off);
          const onMs = summary(latency.on);
          const expectation = { samples: rounds, budgetMs: COMPLETION_BUDGET_MS };
          record(
            {
              cell: "data-saving-completion",
              ...base,
              budgetMs: COMPLETION_BUDGET_MS,
              dataSavingOff: offMs,
              dataSavingOn: onMs,
            },
            [
              ...latencyProblems("completion, data saving off", offMs, expectation),
              ...latencyProblems("completion, data saving on", onMs, expectation),
            ],
          );
        }
        // Approval visibility with and without data saving: a tool call parks
        // an approval (the composer's "ask" mode, on an "ask" environment);
        // the time from the backend parking it to the card in each client.
        {
          type Interaction = {
            id: string;
            kind: string;
            state: string;
            presentation?: { confirmLabel?: string };
          };
          type Projection = {
            interactions?: Interaction[];
            composer?: { approvalModes?: Array<{ id: string; kind: string }> };
          };
          const identity = {
            environmentId: askEnvironment.id,
            agent: "claude",
            logicalSessionKey: `env-${askEnvironment.id}:${AGENT_TAB}`,
          };
          const projection = () =>
            command<Projection | null>("get_native_agent_projection", {
              ...identity,
              messageLimit: 20,
            }).catch(() => null);
          const askMode = (await projection())?.composer?.approvalModes?.find(
            (entry) => entry.kind === "ask",
          );
          if (askMode) {
            await command("update_native_agent_controls", {
              ...identity,
              update: { approvalMode: askMode.id },
            });
          }
          const latency: Record<"off" | "on", Array<number | null>> = { off: [], on: [] };
          const parkedAfterAnswerMs: number[] = [];
          let notes = askMode ? `composer ask mode ${askMode.id}` : "no ask composer mode";
          const rounds = Math.max(ROUNDS, 5);
          for (let round = 0; round < rounds; round += 1) {
            const word = tag("RBWASK");
            await send(normal.page, `${word} [bash:${word.toLowerCase()}]`);
            let parked: Interaction | undefined;
            const parkedMs = await msUntil(
              Date.now(),
              async () => {
                parked = (await projection())?.interactions?.find(
                  (entry) => entry.state === "pending" && /approval|permission/.test(entry.kind),
                );
                return Boolean(parked);
              },
              60_000,
            );
            if (parkedMs === null || !parked) {
              notes += `; no approval parked within 60 s (${model.callsWith(word).length} model calls for the prompt)`;
              break;
            }
            const parkedAt = Date.now();
            const answeredAt = model.callsWith(word).find((call) => call.answeredAt)?.answeredAt;
            if (answeredAt) parkedAfterAnswerMs.push(parkedAt - answeredAt);
            const label = parked.presentation?.confirmLabel ?? "Approve";
            const confirm = (page: Page) =>
              page.getByRole("button", { name: label, exact: true }).first();
            const [off, on] = await Promise.all(
              pair.map((client) =>
                msUntil(parkedAt, () => confirm(client.page).isVisible(), 30_000),
              ),
            );
            latency.off.push(off);
            latency.on.push(on);
            if (off === null) {
              notes += `; no "${label}" button in the normal client`;
              break;
            }
            await confirm(normal.page).click();
            await expect(composer(normal.page)).toBeEditable({ timeout: 60_000 });
          }
          const offMs = summary(latency.off);
          const onMs = summary(latency.on);
          // A round that parked no approval took no sample, so the cell is incomplete.
          const expectation = { samples: rounds, budgetMs: APPROVAL_BUDGET_MS };
          record(
            {
              cell: "data-saving-approval",
              ...base,
              budgetMs: APPROVAL_BUDGET_MS,
              notes,
              parkedAfterModelAnswerMs: summary(parkedAfterAnswerMs),
              dataSavingOff: offMs,
              dataSavingOn: onMs,
            },
            [
              ...latencyProblems("approval, data saving off", offMs, expectation),
              ...latencyProblems("approval, data saving on", onMs, expectation),
            ],
          );
        }
      }
      expect(shortfalls, "every cell qualified (evidence keeps the rest)").toEqual([]);
    } finally {
      for (const created of [environment, askEnvironment]) {
        if (!invoke || !created) continue;
        await invoke("stop_environment", { environmentId: created.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: created.id }).catch(() => undefined);
      }
      for (const client of clients) await closeClient(client);
    }
  });
}
