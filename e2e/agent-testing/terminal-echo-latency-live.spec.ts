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
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  parseAgentAccountsSnapshot,
} from "@orkestrator/protocol/agent-accounts";
import { TERMINAL_WEBSOCKET_PATH } from "@orkestrator/protocol/terminal-websocket";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BrowserContext } from "@playwright/test";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  fakeModelClaudeSettings,
  MAX_STREAM_DELTAS,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import {
  loadRuntimeProfileSync,
  resolveRuntimeProfile,
  statusManifestPath,
} from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile: string;
  flavor: string;
  dataDir: string;
  statusPath: string;
  browserUrl: string;
  testProject: string;
  live: Record<string, boolean>;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Variant = "idle" | "backend-only" | "agent-visible" | "hidden-tabs" | "hidden-tabs-direct";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "echo8312";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO === "1";
const FAKE_MODEL_PORT = integerOption("ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT", 0, 0, 65535);
const ALL_VARIANTS: Variant[] = [
  "idle",
  "backend-only",
  "agent-visible",
  "hidden-tabs",
  "hidden-tabs-direct",
];
/** The renderer's measurement switch (`terminal-background-writes.ts`). */
const BACKGROUND_WRITES_KEY = "orkestrator-terminal-background-writes";
function parseIntegerOption(name: string, raw: string | number, min: number, max: number) {
  const value = typeof raw === "string" && !raw.trim() ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function integerOption(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return LIVE ? parseIntegerOption(name, process.env[name] ?? fallback, min, max) : fallback;
}

function parseVariants(option: string): Variant[] {
  const variants = option.split(",").map((variant) => variant.trim());
  if (
    variants.some((variant) => !ALL_VARIANTS.includes(variant as Variant)) ||
    new Set(variants).size !== variants.length
  ) {
    throw new Error("ORKESTRATOR_AGENT_TEST_ECHO_VARIANTS must list distinct supported variants");
  }
  return variants as Variant[];
}

const VARIANTS = LIVE
  ? parseVariants(process.env.ORKESTRATOR_AGENT_TEST_ECHO_VARIANTS ?? ALL_VARIANTS.join(","))
  : ALL_VARIANTS;
const ROUNDS = integerOption("ORKESTRATOR_AGENT_TEST_ECHO_ROUNDS", 3, 1);
const KEYS = integerOption("ORKESTRATOR_AGENT_TEST_ECHO_KEYS", 200, 20);
const WARMUP_KEYS = 10;
/** Pause between an echo and the next key, as the loopback benchmark uses. */
const KEY_GAP_MS = 30;
/**
 * Up to one 60 Hz frame added to each gap, so keys land at every phase of the
 * page's frame clock as a person's do. Chromium defers ordinary tasks after a
 * key until the next frame, so an echo paints one or two frames after its key
 * depending on that phase. With a fixed gap the phase was set by Playwright's
 * own round trips, which slow as a case records steps, and the median drifted
 * from one cluster to the other between rounds (to-do 8312 task 4).
 */
const KEY_PHASE_SPREAD_MS = 1000 / 60;
/** The `index`th gap's spread: a golden-ratio sequence, even over the frame. */
function keyPhaseOffsetMs(index: number): number {
  return ((index * 0.618_033_988_75) % 1) * KEY_PHASE_SPREAD_MS;
}
const ECHO_TIMEOUT_MS = 5_000;
/** The load shape: the loopback benchmark's `busy` level. */
const LOAD = {
  build: integerOption("ORKESTRATOR_AGENT_TEST_ECHO_BUILD", 3, 0),
  tool: integerOption("ORKESTRATOR_AGENT_TEST_ECHO_TOOL", 2, 0),
  agents: integerOption("ORKESTRATOR_AGENT_TEST_ECHO_AGENTS", 4, 0),
  buildBytesPerSecond: 256 * 1024,
  toolBurstBytes: 2 * 1024 * 1024,
  toolEveryMs: 1_500,
};
/** Lines per streamed answer, 25 ms apart: long enough to cover a measured run. */
const STREAM_DELTAS = integerOption(
  "ORKESTRATOR_AGENT_TEST_ECHO_STREAM",
  1600,
  1,
  MAX_STREAM_DELTAS,
);
const KEY_CYCLE = "abcdefghijklmnopqrstuvwxyz0123456789";
/**
 * Opt-in: record a Chromium CPU profile of the measured page over each cell's
 * measured keys, written beside the evidence as `page-<variant>-r<round>.cpuprofile`
 * (function names and source locations only). Sampling slows the page, so a
 * profiled run's latencies are not comparable with an unprofiled one's.
 */
const PAGE_CPU_PROFILE = LIVE && process.env.ORKESTRATOR_AGENT_TEST_ECHO_CPU_PROFILE === "1";
/**
 * Opt-in: record a Chromium performance trace of the measured page over each
 * cell's measured keys, as `trace-<variant>-r<round>.json` (timeline events
 * only, no screenshots).
 */
const PAGE_TRACE = LIVE && process.env.ORKESTRATOR_AGENT_TEST_ECHO_TRACE === "1";
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "toplevel",
  "input",
  "loading",
  "v8",
  "blink.user_timing",
];
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
  if (command.status !== 0) throw new Error("The benchmark needs a running fixture profile");
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  const expected = runtime();
  expect(status.flavor).toBe("agent-test");
  expect(status.statusPath).toBe(statusManifestPath(expected));
  expect(status.dataDir).toBe(expected.dataDir);
  expect(status.testProject).toBe(path.join(expected.fixtureDir, "test-project"));
  const gateway = new URL(status.browserUrl);
  expect(gateway.protocol).toBe("http:");
  expect(gateway.hostname).toBe("127.0.0.1");
  for (const service of ["launcher", "vite", "electron", "backend"]) {
    expect(status.live[service], `${service} is running`).toBe(true);
  }
  const config = loadRuntimeProfileSync(path.join(expected.profileRoot, "profile.json"));
  expect(config.id).toBe(status.profile);
  expect(config.dataDir).toBe(status.dataDir);
  expect(config.hostSeedDisabled, "start with --no-host-seed").toBe(true);
  expect(config.credentialSources, "start with --no-agent-credentials").toEqual([]);
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
    mean: sorted.length
      ? Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(1))
      : null,
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

async function createEnvironment(
  invoke: Invoke,
  fixture: Project,
  label: string,
  createdEnvironments: Environment[],
) {
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `echo-${label}-${Date.now().toString(36)}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  createdEnvironments.push(created);
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
    // Split each key's latency into the keystroke's own command request and
    // the echo's way back: the page's own `fetch` call time (`sent`), then
    // resource timing (URLs and timings only) for the rest.
    const sentAt: number[] = [];
    const originalFetch = window.fetch;
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/__orkestrator/invoke")) sentAt.push(performance.now());
      return originalFetch(input, init);
    }, originalFetch);
    performance.setResourceTimingBufferSize(100_000);
    performance.clearResourceTimings();
    const writes: Record<
      "sent" | "start" | "queued" | "server" | "duration" | "echoAfterStart",
      number[]
    > = { sent: [], start: [], queued: [], server: [], duration: [], echoAfterStart: [] };
    const recordWrite = () => {
      if (!armed || armed.keyAt === null || armed.echoAt === null) return;
      const keyAt = armed.keyAt;
      const sent = sentAt.find((at) => at >= keyAt);
      if (sent !== undefined) writes.sent.push(sent - keyAt);
      sentAt.splice(0);
      const entry = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(
        (candidate) =>
          candidate.name.includes("/__orkestrator/invoke") && candidate.startTime >= keyAt,
      );
      if (!entry) return;
      writes.start.push(entry.startTime - keyAt);
      writes.queued.push(entry.requestStart - entry.startTime);
      writes.server.push(entry.responseStart - entry.requestStart);
      writes.duration.push(entry.duration);
      writes.echoAfterStart.push(armed.echoAt - entry.startTime);
    };
    (window as unknown as { __echoProbe: unknown }).__echoProbe = {
      arm(suffix: string) {
        armed = { suffix, keyAt: null, echoAt: null };
      },
      wait(timeoutMs: number) {
        if (armed && armed.echoAt !== null) {
          recordWrite();
          return Promise.resolve({ keyAt: armed.keyAt, echoAt: armed.echoAt });
        }
        return new Promise<{ keyAt: number | null; echoAt: number | null }>((done) => {
          const finish = () => {
            clearTimeout(timer);
            resolve = null;
            recordWrite();
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
        const requests = Object.fromEntries(
          Object.entries(writes).map(([name, values]) => [name, values.splice(0)]),
        );
        performance.clearResourceTimings();
        return {
          requests,
          longTasks: tasks.length,
          longTaskMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)),
          longestTaskMs: Math.round(Math.max(0, ...tasks)),
          frameGaps: gaps,
        };
      },
      stop() {
        window.fetch = originalFetch;
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

async function typeAndTime(page: Page, sessionId: string, profileName?: string) {
  await installProbe(page);
  const cdp = profileName && PAGE_CPU_PROFILE ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  }
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
    requests: Record<string, number[]>;
  } | null = null;
  for (let index = 0; index < WARMUP_KEYS + KEYS; index += 1) {
    if (index === WARMUP_KEYS) {
      await page.evaluate(() =>
        (window as unknown as { __echoProbe: { stats(): unknown } }).__echoProbe.stats(),
      );
      if (cdp) await cdp.send("Profiler.start");
      if (PAGE_TRACE && profileName) {
        await page
          .context()
          .browser()!
          .startTracing(page, {
            path: test.info().outputPath(`trace-${profileName}.json`),
            categories: TRACE_CATEGORIES,
          });
      }
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
    await page.waitForTimeout(KEY_GAP_MS + keyPhaseOffsetMs(index));
  }
  if (PAGE_TRACE && profileName) await page.context().browser()!.stopTracing();
  if (cdp && profileName) {
    const { profile } = await cdp.send("Profiler.stop");
    const file = test.info().outputPath(`page-${profileName}.cpuprofile`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(profile));
    await cdp.detach();
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
            requests: Record<string, number[]>;
          };
          stop(): void;
        };
      }
    ).__echoProbe.stats(),
  );
  await page.evaluate(() =>
    (window as unknown as { __echoProbe: { stop(): void } }).__echoProbe.stop(),
  );
  const { frameGaps, requests, ...tasks } = stats;
  return {
    keyToEchoMs: { ...summarise(latencies), timeouts },
    frameGapMs: summarise(frameGaps),
    /** Each key's first command request after its keydown, from resource timing. */
    keyRequestMs: Object.fromEntries(
      Object.entries(requests).map(([name, values]) => [name, summarise(values)]),
    ),
    ...tasks,
  };
}

// ---------------------------------------------------------------------------
// The run

type EventLoop = {
  ticks: number;
  lateTicks: Record<string, number>;
  stalls: number;
};
type LoopReading = { counters: EventLoop } | { unavailable: string };
const stallBuckets = ["100", "1000", "5000", "30000"];
const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function backendLoop(page: Page, gatewayUrl: string): Promise<LoopReading> {
  const response = await page.request
    .get(new URL("/__orkestrator/metrics", gatewayUrl).href)
    .catch(() => null);
  return readLoopMetrics(response);
}

async function readLoopMetrics(
  response: {
    ok(): boolean;
    status(): number;
    json(): Promise<unknown>;
  } | null,
): Promise<LoopReading> {
  if (!response) return { unavailable: "metrics request failed" };
  if (!response.ok()) return { unavailable: `HTTP ${response.status()}` };
  const body = (await response.json().catch(() => null)) as {
    eventLoop?: Partial<EventLoop>;
  } | null;
  const counters = body?.eventLoop;
  if (!counters) return { unavailable: "event-loop monitor absent" };
  if (
    !isCounter(counters.ticks) ||
    !isCounter(counters.stalls) ||
    !stallBuckets.every((bucket) => isCounter(counters.lateTicks?.[bucket]))
  ) {
    return { unavailable: "event-loop counters incomplete" };
  }
  return { counters: counters as EventLoop };
}

function loopDelta(before: LoopReading, after: LoopReading) {
  if ("unavailable" in before) return before;
  if ("unavailable" in after) return after;
  const ticks = after.counters.ticks - before.counters.ticks;
  const stalls = after.counters.stalls - before.counters.stalls;
  const lateTicks = Object.fromEntries(
    stallBuckets.map((bucket) => [
      bucket,
      after.counters.lateTicks[bucket]! - before.counters.lateTicks[bucket]!,
    ]),
  );
  if (ticks <= 0 || stalls < 0 || Object.values(lateTicks).some((delta) => delta < 0)) {
    return { unavailable: "event-loop counters did not advance monotonically" };
  }
  return { ticks, lateTicks, stalls };
}

async function terminalWrite(invoke: Invoke, sessionId: string, data: string) {
  const result = await invoke<{ delivered: boolean }>("local_terminal_write", { sessionId, data });
  expect(result.delivered, `PTY write delivered to ${sessionId}`).toBe(true);
}

type OutputCursor = { generation: number; revision: number };

async function outputCursors(invoke: Invoke, sessions: string[]) {
  // Read only revision metadata from the response. Never include PTY output
  // in the evidence.
  return Promise.all(
    sessions.map((sessionId) =>
      invoke<OutputCursor>("get_terminal_output_snapshot", { sessionId }),
    ),
  );
}

function assertCellLoad(
  loadBefore: OutputCursor[],
  loadAfter: OutputCursor[],
  streamsCovered: boolean,
  measured: { samples: number; timeouts: number },
) {
  for (const [index, before] of loadBefore.entries()) {
    const after = loadAfter[index]!;
    expect(after.generation, `producer ${index + 1} generation`).toBe(before.generation);
    expect(after.revision, `producer ${index + 1} output during typing`).toBeGreaterThan(
      before.revision,
    );
  }
  expect(streamsCovered, "all requested streams cover the typing window").toBe(true);
  expect(measured.samples, "measured keys echoed").toBe(KEYS);
  expect(measured.timeouts, "key timeouts").toBe(0);
}

const evidence: { run: Record<string, unknown>; cells: Record<string, unknown>[] } = {
  run: {},
  cells: [],
};
function assertIsolatedClaudeAccount(value: unknown) {
  const accounts = parseAgentAccountsSnapshot(value);
  const claudeAccounts = accounts?.accounts.filter(({ platform }) => platform === "claude");
  const account = claudeAccounts?.[0];
  if (
    accounts?.active.claude !== DEFAULT_AGENT_ACCOUNT_ID ||
    claudeAccounts?.length !== 1 ||
    account?.id !== DEFAULT_AGENT_ACCOUNT_ID ||
    !account.isDefault ||
    !account.isActive ||
    account.signedIn
  ) {
    throw new Error("The benchmark requires the isolated default Claude account");
  }
}

async function configureFakeModel(status: Status, invoke: Invoke, model: FakeAnthropicModel) {
  assertIsolatedClaudeAccount(await invoke("list_agent_accounts"));
  const claudeDir = path.join(status.dataDir, "agent-credentials", "claude");
  await fs.mkdir(claudeDir, { recursive: true });
  if ((await fs.realpath(claudeDir)) !== claudeDir) {
    throw new Error("The profile Claude home must not redirect outside its directory");
  }
  const entries = await fs.readdir(claudeDir);
  if (entries.some((name) => name === "settings.json" || name === ".credentials.json")) {
    throw new Error("The isolated Claude home already contains settings or credentials");
  }
  const settings = path.join(claudeDir, "settings.json");
  await fs.writeFile(settings, JSON.stringify(fakeModelClaudeSettings(model.origin)), {
    flag: "wx",
  });
  return settings;
}

test("key-to-echo latency per load variant", async ({ browser }) => {
  test.setTimeout(90 * 60_000);
  const status = readyStatus();
  const gatewayUrl = status.browserUrl;
  evidence.run = {
    profile,
    variants: VARIANTS,
    rounds: ROUNDS,
    keys: KEYS,
    warmupKeys: WARMUP_KEYS,
    keyGapMs: KEY_GAP_MS,
    keyPhaseSpreadMs: KEY_PHASE_SPREAD_MS,
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
  let model: FakeAnthropicModel | undefined;
  let settingsPath: string | undefined;
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
    const fakeModel = await startFakeAnthropicModel(FAKE_MODEL_PORT);
    model = fakeModel;
    settingsPath = await configureFakeModel(status, invoke, fakeModel);
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
    const terminalOnly = await createEnvironment(invoke, fixture!, "w", created);
    const withAgent = await createEnvironment(invoke, fixture!, "u", created);
    const withHidden = await createEnvironment(invoke, fixture!, "t", created);
    await seedLayout(invoke, terminalOnly.id, terminalLeaf([]));
    await seedLayout(invoke, withAgent.id, split([terminalLeaf([]), agentLeaf(withAgent.id)]));
    await seedLayout(
      invoke,
      withHidden.id,
      split([terminalLeaf(hiddenLoadTabs), agentLeaf(withHidden.id)]),
    );
    const backgroundAgents: Environment[] = [];
    for (let index = 0; index < Math.max(0, LOAD.agents - 2); index += 1) {
      const environment = await createEnvironment(invoke, fixture!, `a${index}`, created);
      await seedLayout(invoke, environment.id, agentLeaf(environment.id));
      backgroundAgents.push(environment);
    }
    const agentEnvironments = LOAD.agents > 0 ? [withAgent, withHidden, ...backgroundAgents] : [];

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
      await terminalWrite(invoke, sessionId, "clear; stty raw -echo && exec cat\n");
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
            fakeModel
              .callsWith(`ECHOWARM${environment.id.slice(0, 6)}`)
              .some((call) => call.answeredAt),
          {
            timeout: 180_000,
          },
        )
        .toBe(true);
    }

    let turn = 0;
    const startAgents = async (visibleEnvironment: Environment) => {
      const words: string[] = [];
      // A one-agent hidden-tabs cell still needs its visible agent.
      const agents = agentEnvironments.filter(({ id }) => id !== visibleEnvironment.id);
      if (agents.length !== agentEnvironments.length) agents.unshift(visibleEnvironment);
      for (const environment of agents.slice(0, LOAD.agents)) {
        turn += 1;
        const word = `ECHOLOAD${turn}X`;
        await prompt(environment, `${word} [hold:${word}] [stream:${STREAM_DELTAS}]`);
        words.push(word);
      }
      for (const word of words) {
        await expect
          .poll(() => fakeModel.callsWith(word).some((call) => call.hold && !call.aborted), {
            timeout: 120_000,
          })
          .toBe(true);
      }
      for (const driver of drivers.values()) await driver.goto("about:blank");
      return words;
    };
    const startTerminals = async (sessions: string[]) => {
      for (const [index, sessionId] of sessions.entries()) {
        await terminalWrite(command, sessionId, loadCommands[index]!);
      }
    };
    const stopTerminals = async (sessions: string[]) => {
      for (const sessionId of sessions) {
        await terminalWrite(command, sessionId, "\u0003");
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
        if (loaded) words = await startAgents(environment);
        const directWrites = variant === "hidden-tabs-direct";
        await measured.evaluate(
          ([key, direct]) => {
            if (direct) localStorage.setItem(key, "off");
            else localStorage.removeItem(key);
          },
          [BACKGROUND_WRITES_KEY, directWrites] as const,
        );
        // The setting is read at mount. Reload both A/B variants to start
        // with the intended mode even when an inactive environment stays mounted.
        if (hiddenTabs) {
          await measured.reload({ waitUntil: "domcontentloaded" });
          await dismissStartupDialogs(measured, fixture!.name);
        }
        await openEnvironment(measured, environment, environment !== terminalOnly);
        if (loaded) await startTerminals(loadSessions);
        // Let the load reach a steady state and the page settle after the switch.
        await measured.waitForTimeout(loaded ? 4_000 : 2_000);
        const loadBefore = loaded ? await outputCursors(command, loadSessions) : [];
        const loopBefore = await backendLoop(measured, gatewayUrl);
        for (const word of words) fakeModel.release(word);
        await expect
          .poll(() =>
            words.every((word) =>
              fakeModel.callsWith(word).some((call) => call.answeredAt && !call.aborted),
            ),
          )
          .toBe(true);
        const slicesBefore = hiddenTabs ? await idleSlices(measured) : null;
        const startedAt = Date.now();
        const monotonicAtStart = process.hrtime.bigint();
        const result = await typeAndTime(
          measured,
          typing.get(environment.id)!,
          PAGE_CPU_PROFILE || PAGE_TRACE ? `${variant}-r${round + 1}` : undefined,
        );
        const endedAt = Date.now();
        const hiddenIdleSlices =
          slicesBefore === null ? null : (await idleSlices(measured)) - slicesBefore;
        if (hiddenIdleSlices !== null && loadSessions.length > 0) {
          if (directWrites) expect(hiddenIdleSlices, "direct cell bypasses idle slices").toBe(0);
          else
            expect(
              hiddenIdleSlices,
              "idle cell parses hidden output during typing",
            ).toBeGreaterThan(0);
        }
        const loopAfter = await backendLoop(measured, gatewayUrl);
        const loadAfter = loaded ? await outputCursors(command, loadSessions) : [];
        if (loaded) await stopTerminals(loadSessions);
        const agentsStreamedThroughout = words.every((word) =>
          fakeModel
            .callsWith(word)
            .some(
              (call) =>
                call.answeredAt !== undefined &&
                call.answeredAt <= startedAt &&
                !call.aborted &&
                (!call.streamedAt || call.streamedAt >= endedAt),
            ),
        );
        assertCellLoad(loadBefore, loadAfter, agentsStreamedThroughout, result.keyToEchoMs);
        const cell = {
          variant,
          round: round + 1,
          startedAt: new Date(startedAt).toISOString(),
          /** The runner's monotonic clock at `startedAt`, to slice a `--cpu-prof` profile. */
          monotonicStartUs: Number(monotonicAtStart / 1000n),
          durationMs: endedAt - startedAt,
          agentsStreamedThroughout,
          hiddenIdleSlices,
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
              () =>
                words.every((word) => fakeModel.callsWith(word).some((call) => call.streamedAt)),
              {
                timeout: STREAM_DELTAS * 25 + 120_000,
              },
            )
            .toBe(true);
          await measured.waitForTimeout(3_000);
        }
      }
    }
    expect(evidence.cells).toHaveLength(ROUNDS * VARIANTS.length);
  } finally {
    for (const environment of created) {
      if (!invoke) break;
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    for (const context of contexts) await context.close().catch(() => undefined);
    try {
      if (settingsPath) await fs.rm(settingsPath, { force: true });
    } finally {
      await model?.stop();
    }
    const file = test.info().outputPath("evidence-terminal-echo.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
    progress(`evidence written to ${file}`);
  }
});

async function idleSlices(page: Page) {
  return page.evaluate(async () => {
    const moduleUrl = "/src/lib/terminal-background-writes.ts";
    const { backgroundWriteScheduler } = (await import(moduleUrl)) as {
      backgroundWriteScheduler(): { metrics: { slices: number } };
    };
    return backgroundWriteScheduler().metrics.slices;
  });
}

async function inspectTerminal(page: Page, environmentId: string, tabId: string) {
  // Use the actual xterm buffer, including rows outside the DOM viewport.
  return page.evaluate(
    async ({ environmentId, tabId }) => {
      const storeUrl = "/src/stores/terminalPortalStore.ts";
      const schedulerUrl = "/src/lib/terminal-background-writes.ts";
      type TerminalView = {
        environmentId: string;
        tabId: string;
        terminal: {
          rows: number;
          buffer: {
            active: {
              length: number;
              viewportY: number;
              getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
            };
          };
        };
      };
      const { useTerminalPortalStore } = (await import(storeUrl)) as {
        useTerminalPortalStore: { getState(): { terminals: Map<string, TerminalView> } };
      };
      const { backgroundWriteScheduler } = (await import(schedulerUrl)) as {
        backgroundWriteScheduler(): { metrics: { slices: number } };
      };
      const data = Array.from(useTerminalPortalStore.getState().terminals.values()).find(
        (entry) => entry.environmentId === environmentId && entry.tabId === tabId,
      );
      const buffer = data?.terminal.buffer.active;
      const lines: number[] = [];
      const screen: number[] = [];
      const screenRows: string[] = [];
      let ready = false;
      for (let index = 0; buffer && index < buffer.length; index += 1) {
        const row = buffer.getLine(index)?.translateToString(true) ?? "";
        const line = row.trim();
        const visible = index >= buffer.viewportY && index < buffer.viewportY + data!.terminal.rows;
        if (visible) screenRows.push(row);
        if (line === "ECHO-REVEAL-ATTACHED") ready = true;
        if (!/^\d+$/u.test(line)) continue;
        lines.push(Number(line));
        if (visible) screen.push(Number(line));
      }
      // Compare every visible row without returning shell prompts or terminal text.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(screenRows)),
      );
      return {
        ready,
        lines,
        screen,
        screenDigest: Array.from(new Uint8Array(digest)),
        slices: backgroundWriteScheduler().metrics.slices,
      };
    },
    { environmentId, tabId },
  );
}

test("a hidden tab shows every line once revealed", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const status = readyStatus();
  const gatewayUrl = status.browserUrl!;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let invoke: Invoke | undefined;
  const created: Environment[] = [];
  try {
    await fetchModulesOutsideChromium(context);
    await context.addInitScript((socketPath) => {
      if (location.protocol === "http:")
        localStorage.setItem("orkestrator-terminal-transport", "websocket");
      const terminalSockets = new Set<WebSocket>();
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args: ConstructorParameters<typeof WebSocket>) {
          const socket = new target(...args);
          if (new URL(socket.url).pathname === socketPath) {
            terminalSockets.add(socket);
            socket.addEventListener("close", () => terminalSockets.delete(socket), { once: true });
          }
          return socket;
        },
      });
      Object.assign(window, { __echoTerminalSockets: terminalSockets });
    }, TERMINAL_WEBSOCKET_PATH);
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
    const environment = await createEnvironment(invoke, fixture!, "reveal", created);
    const hiddenTab = "echo-reveal";
    await seedLayout(invoke, environment.id, terminalLeaf([hiddenTab]));
    await terminalSession(invoke, environment.id, TYPING_TAB);
    const hidden = await terminalSession(invoke, environment.id, hiddenTab);
    await page.goto(gatewayUrl, { waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page, fixture!.name);
    await openEnvironment(page, environment, false);
    const selectTab = (tabId: string) =>
      page.locator(`[id="pane-tab:${environment.id}:echo-terminal-pane:${tabId}"]`).click();
    const inspect = () => inspectTerminal(page, environment.id, hiddenTab);
    await selectTab(hiddenTab);
    await terminalWrite(invoke, hidden, "printf 'ECHO-REVEAL-ATTACHED\\n'\n");
    await expect.poll(async () => (await inspect()).ready).toBe(true);
    await selectTab(TYPING_TAB);
    const slicesBefore = (await inspect()).slices;
    const lineCount = 600; // Fits the fixture's default 1,000-line scrollback.
    const expected = Array.from({ length: lineCount }, (_, index) => index + 1);
    await terminalWrite(invoke, hidden, `clear; seq 1 ${lineCount}\n`);
    await expect
      .poll(async () => (await inspect()).slices, { timeout: 60_000 })
      .toBeGreaterThan(slicesBefore);
    await selectTab(hiddenTab);
    await expect.poll(async () => (await inspect()).lines, { timeout: 60_000 }).toEqual(expected);
    const { screen: visibleNumbers, screenDigest } = await inspect();
    expect(visibleNumbers.length).toBeGreaterThan(0);
    expect(visibleNumbers).toEqual(expected.slice(-visibleNumbers.length));

    // Drop the live browser channel and wait for a new subscription
    // before comparing the same terminal buffer.
    const reconnect = page
      .waitForEvent("websocket", {
        predicate: (socket) => new URL(socket.url()).pathname === TERMINAL_WEBSOCKET_PATH,
      })
      .then((socket) =>
        socket.waitForEvent("framereceived", {
          predicate: ({ payload }) =>
            typeof payload === "string" &&
            (JSON.parse(payload) as { type?: string }).type === "subscribed",
        }),
      );
    void reconnect.catch(() => undefined);
    await page.evaluate(() => {
      const sockets = (window as unknown as { __echoTerminalSockets: Set<WebSocket> })
        .__echoTerminalSockets;
      if (!sockets.size) throw new Error("The terminal is not on WebSocket transport");
      for (const socket of sockets) socket.close(4000, "Benchmark reconnect");
    });
    await reconnect;
    await expect.poll(async () => (await inspect()).lines).toEqual(expected);
    await expect.poll(async () => (await inspect()).screenDigest).toEqual(screenDigest);

    // A fresh renderer must recover the retained scrollback and the same
    // visible screen from the backend attachment.
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page, fixture!.name);
    await selectEnvironment(page, environment);
    await selectTab(hiddenTab);
    await expect.poll(async () => (await inspect()).lines, { timeout: 60_000 }).toEqual(expected);
    await expect.poll(async () => (await inspect()).screenDigest).toEqual(screenDigest);
  } finally {
    for (const environment of created) {
      if (!invoke) break;
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
    await context.close().catch(() => undefined);
  }
});

test("echo probe resolves an echo observed before the wait", async ({ page }) => {
  await page.setContent(
    `<div data-terminal-tab-id="${TYPING_TAB}"><div class="xterm-rows"><div></div></div></div>`,
  );
  await installProbe(page);
  const result = await page.evaluate(async (tabId) => {
    const host = document.querySelector(`[data-terminal-tab-id="${tabId}"]`)!;
    const probe = (
      window as unknown as {
        __echoProbe: {
          arm(suffix: string): void;
          wait(ms: number): Promise<{ keyAt: number | null; echoAt: number | null }>;
          stop(): void;
        };
      }
    ).__echoProbe;
    try {
      probe.arm("echo");
      host.dispatchEvent(new KeyboardEvent("keydown"));
      host.querySelector(".xterm-rows div")!.textContent = "echo";
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return await Promise.race([
        probe.wait(5_000),
        // The already observed echo must settle in the current turn.
        Promise.resolve().then(() => "did not resolve the recorded echo"),
      ]);
    } finally {
      probe.stop();
    }
  }, TYPING_TAB);
  expect(result).toEqual({ keyAt: expect.any(Number), echoAt: expect.any(Number) });
});

test("key gaps spread over every phase of a frame", () => {
  const offsets = Array.from({ length: 200 }, (_, index) => keyPhaseOffsetMs(index));
  expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...offsets)).toBeLessThan(KEY_PHASE_SPREAD_MS);
  // Every quarter of the frame gets a quarter of the keys, within a few.
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const inQuarter = offsets.filter(
      (offset) => Math.floor((offset / KEY_PHASE_SPREAD_MS) * 4) === quarter,
    ).length;
    expect(Math.abs(inQuarter - 50)).toBeLessThanOrEqual(3);
  }
});

test("harness rejects invalid setup and incomplete measurements", async () => {
  expect(() => parseVariants("idle,unknown")).toThrow("supported variants");
  expect(() => parseIntegerOption("ROUNDS", "invalid", 1, 10)).toThrow("ROUNDS");
  const defaultClaude = {
    id: DEFAULT_AGENT_ACCOUNT_ID,
    platform: "claude",
    label: "Default",
    isDefault: true,
    isActive: true,
    signedIn: false,
    identity: {},
  };
  const active = { claude: DEFAULT_AGENT_ACCOUNT_ID, codex: DEFAULT_AGENT_ACCOUNT_ID };
  expect(() => assertIsolatedClaudeAccount({ accounts: [defaultClaude], active })).not.toThrow();
  expect(() =>
    assertIsolatedClaudeAccount({
      accounts: [
        { ...defaultClaude, isActive: false },
        { ...defaultClaude, id: "alternate", isDefault: false },
      ],
      active: { ...active, claude: "alternate" },
    }),
  ).toThrow("isolated default Claude account");
  expect(() =>
    assertIsolatedClaudeAccount({
      accounts: [{ ...defaultClaude, signedIn: true }],
      active,
    }),
  ).toThrow("isolated default Claude account");

  const undelivered: Invoke = async <T>() => ({ delivered: false }) as T;
  await expect(terminalWrite(undelivered, "fixture", "fixture input")).rejects.toThrow(
    "PTY write delivered",
  );

  const cursor = { generation: 1, revision: 3 };
  const advancing = [{ ...cursor, revision: 4 }];
  const counts = { samples: KEYS, timeouts: 0 };
  expect(() => assertCellLoad([cursor], [cursor], true, counts)).toThrow("output during typing");
  expect(() => assertCellLoad([cursor], advancing, false, counts)).toThrow("streams cover");
  expect(() =>
    assertCellLoad([cursor], advancing, true, { samples: KEYS - 1, timeouts: 1 }),
  ).toThrow("measured keys echoed");

  const response = (status: number, body: unknown) => ({
    ok: () => status === 200,
    status: () => status,
    json: async () => body,
  });
  const eventLoop = {
    ticks: 1,
    stalls: 0,
    lateTicks: { "100": 0, "1000": 0, "5000": 0, "30000": 0 },
  };
  const before = await readLoopMetrics(response(200, { eventLoop }));
  expect(loopDelta(before, await readLoopMetrics(response(503, {})))).toEqual({
    unavailable: "HTTP 503",
  });
  expect(loopDelta(before, await readLoopMetrics(response(200, {})))).toEqual({
    unavailable: "event-loop monitor absent",
  });
  expect(
    loopDelta(
      before,
      await readLoopMetrics(response(200, { eventLoop: { ...eventLoop, ticks: 2 } })),
    ),
  ).toEqual({ ticks: 1, stalls: 0, lateTicks: eventLoop.lateTicks });

  for (const failOn of [1, 2]) {
    const created: Environment[] = [];
    const fixture = { id: "project", name: "fixture", localPath: null };
    const failingStart: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === "create_environment") {
        return { id: String(created.length + 1), name: "fixture" } as T;
      }
      if (command === "start_environment" && created.length === failOn) {
        throw new Error("fixture start failed");
      }
      return { id: args?.environmentId, status: "running" } as T;
    };
    for (let index = 1; index < failOn; index += 1) {
      await createEnvironment(failingStart, fixture, "setup-success", created);
    }
    await expect(
      createEnvironment(failingStart, fixture, "setup-failure", created),
    ).rejects.toThrow("fixture start failed");
    expect(created.map(({ id }) => id)).toEqual(
      Array.from({ length: failOn }, (_, i) => String(i + 1)),
    );
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
