/**
 * Two real `dev:test` profiles on one host, the second attached to the first
 * as its leaf, driven in headless Chromium with no login and nothing billed.
 * Run it with `mise run test:agent:federation:two-profile`, which starts both
 * profiles (credential-free, Pi only, `--no-host-seed`), runs this file and
 * resets both.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_FEDERATION_TWO_PROFILE=1`.
 * `ORKESTRATOR_AGENT_TEST_PROFILE` is the command node and
 * `ORKESTRATOR_AGENT_TEST_FEDERATION_LEAF_PROFILE` the leaf. The leaf's Pi
 * runs real native turns against `federation-two-profile-fake-model.ts` on
 * loopback, named by the leaf profile's isolated Pi `models.json` (never
 * `~/.pi`); the fake holds each turn open until the spec releases it, which
 * is what moves the leaf's activity between working and idle.
 *
 * - **Remote-row activity** (to-do 2190 (retired) task 3). One page signed in
 *   to the command node, one to the leaf. For several held turns, the time
 *   each view first shows the leaf environment working, then idle, is taken
 *   against the leaf backend's own record. The command node's row must keep
 *   up: within `ACTIVITY_LAG_BUDGET_MS` of the leaf's backend, far inside the
 *   60 s reconcile that would otherwise be the only path.
 * - **Per-node relayed events** (to-do 5840 (retired) task 1). The command
 *   page's streams are recorded (an init script wraps `EventSource`; frames
 *   are reduced to names, node ids and kinds). The main stream must carry no
 *   relayed frame, a relayed stream must name the leaf, and under a flood of
 *   leaf file changes the relayed ring must move while the main ring barely
 *   does. Then the tab goes away (hidden, offline, streams dropped) while the
 *   leaf changes and starts a turn; back again, and after a reload, the
 *   remote row's change badge and activity must match the leaf's own row.
 * - **Older peers on the wire** (to-do 5840 (retired) task 2). A second
 *   command page has its main stream's `relayedEvents=per-node` stripped and
 *   `perNodeEvents` removed from `watch_node_events` answers: what an older
 *   renderer sends and what an older command node answers look the same on
 *   the wire. Relayed events must arrive under the one old name, a reconnect
 *   must bring a `resync` for the leaf, the badge must stay right, and the
 *   `relayed-node-event.legacy-stream` counter must move only in this phase.
 *   Real older releases are a manual check (to-do 7568).
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/federation-two-profile/summary.json`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  decodedBodyHeaders,
  expect,
  fetchModulesOutsideChromium,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "./browser-test";
import { pointPiAt } from "./coordinator-two-node-support";
import {
  HOLD_MARKER,
  MODEL_REF,
  PI_PROVIDER,
  FAKE_MODEL_ID,
  describeStream,
  isRelayedFrame,
  lagSummary,
  legacyMainStreamUrl,
  withoutPerNodeEvents,
  type FrameFacts,
} from "./federation-two-profile-support";
import {
  attachLeaf,
  createLeafEnvironment,
  gateway,
  loginUrl,
  repositoryRoot,
  type Gateway,
} from "./scope-proof-support";
import { sidebarEnvironmentRow } from "./sidebar-project";
import { profileStatus } from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_FEDERATION_TWO_PROFILE === "1";
const commandProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "";
const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_FEDERATION_LEAF_PROFILE ?? "";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? (commandProfile || "federation");
const SUMMARY_DIR = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "federation-two-profile",
);

/**
 * How far behind the leaf's own record the command node's row may be. The
 * path is the leaf's `resource-changed`, the read model's 250 ms debounce,
 * its 1 s announcement interval and the client's re-read; the 60 s reconcile
 * is the fallback, and a row that only caught up through it fails here.
 */
const ACTIVITY_LAG_BUDGET_MS = 10_000;
const ACTIVITY_CYCLES = 3;
const FLOOD_WRITES = 40;
const VIEW_TIMEOUT_MS = 60_000;
const LEAF_NAME = "Leaf two-profile";
const COMMAND_NAME = "Command two-profile";
const LEAF_TAB = "federation-two-profile-pi";
const LEGACY_COUNTER = "relayed-node-event.legacy-stream";

type Identity = { environmentId: string; agent: "pi"; logicalSessionKey: string };
type Calls = { completions: number; refused: number; heldTotal: number; held: number };
type RecordedStream = { url: string; total: number; frames: FrameFacts[]; closed: boolean };
type RingStats = { latestRevision: number };

test.describe.configure({ mode: "serial" });
// Direct invokes carry gateway tokens; keep them out of artifacts.
test.use({ trace: "off" });
test.skip(
  !LIVE || !commandProfile || !leafProfile,
  "Run with mise run test:agent:federation:two-profile (ORKESTRATOR_AGENT_TEST_FEDERATION_TWO_PROFILE=1 and two profiles).",
);

/**
 * Runs in every page before the app: records each `EventSource` and its
 * frames (event name, relayed node id, kind and inner event name only), and
 * lets the spec hide the document and drop every stream. Self-contained,
 * because Playwright serialises it into the page.
 */
function installStreamRecorder(): void {
  type Frame = { event: string; nodeId?: string; relayedKind?: string; relayedEvent?: string };
  type Stream = { url: string; total: number; frames: Frame[]; closed: boolean };
  const MAX_FRAMES = 4_000;
  const qa = {
    streams: [] as Stream[],
    sources: new Set<EventSource>(),
    hidden: false,
    setHidden(next: boolean) {
      qa.hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
      if (!next) window.dispatchEvent(new Event("focus"));
    },
    breakStreams(): number {
      const sources = Array.from(qa.sources);
      for (const source of sources) {
        source.close();
        source.onerror?.(new Event("error"));
      }
      return sources.length;
    },
  };
  (window as unknown as { __federationQa: typeof qa }).__federationQa = qa;
  const NativeEventSource = window.EventSource;
  const onMessage = Object.getOwnPropertyDescriptor(NativeEventSource.prototype, "onmessage")!;
  const records = new WeakMap<EventSource, Stream>();
  class RecordingEventSource extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const stream: Stream = { url: String(url), total: 0, frames: [], closed: false };
      qa.streams.push(stream);
      records.set(this, stream);
      qa.sources.add(this);
    }
    override close() {
      qa.sources.delete(this);
      const stream = records.get(this);
      if (stream) stream.closed = true;
      super.close();
    }
  }
  Object.defineProperty(RecordingEventSource.prototype, "onmessage", {
    configurable: true,
    get() {
      return onMessage.get!.call(this);
    },
    set(handler: ((event: MessageEvent) => unknown) | null) {
      const source = this as EventSource;
      const wrapped =
        typeof handler === "function"
          ? function (this: EventSource, message: MessageEvent) {
              const stream = records.get(source);
              if (stream && typeof message.data === "string") {
                stream.total += 1;
                try {
                  const parsed = JSON.parse(message.data) as { event?: unknown; payload?: unknown };
                  if (typeof parsed.event === "string" && stream.frames.length < MAX_FRAMES) {
                    const frame: Frame = { event: parsed.event };
                    if (parsed.event.startsWith("relayed-node-event")) {
                      const relayed = (parsed.payload ?? {}) as Record<string, unknown>;
                      if (typeof relayed.nodeId === "string") frame.nodeId = relayed.nodeId;
                      if (typeof relayed.kind === "string") frame.relayedKind = relayed.kind;
                      if (typeof relayed.event === "string") frame.relayedEvent = relayed.event;
                    }
                    stream.frames.push(frame);
                  }
                } catch {
                  // Not a gateway frame; counted only.
                }
              }
              return handler.call(this, message);
            }
          : handler;
      onMessage.set!.call(this, wrapped);
    },
  });
  window.EventSource = RecordingEventSource as typeof EventSource;
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")!;
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!;
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get() {
      return qa.hidden ? "hidden" : visibility.get!.call(this);
    },
  });
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get() {
      return qa.hidden ? true : hidden.get!.call(this);
    },
  });
}

async function recordedStreams(page: Page): Promise<RecordedStream[]> {
  return page.evaluate(() =>
    (
      window as unknown as { __federationQa: { streams: RecordedStream[] } }
    ).__federationQa.streams.map((stream) => ({ ...stream, frames: [...stream.frames] })),
  );
}

/** What a page's streams carried, by kind; the facts only, never a URL. */
async function streamFacts(page: Page, leafNodeId: string) {
  const streams = (await recordedStreams(page)).map((stream) => ({
    ...stream,
    ...describeStream(stream.url),
  }));
  const main = streams.filter((stream) => stream.kind === "main");
  const relayed = streams.filter((stream) => stream.kind === "relayed");
  const mainFrames = main.flatMap((stream) => stream.frames);
  const relayedFrames = relayed.flatMap((stream) => stream.frames);
  return {
    mainStreams: main.length,
    relayedStreams: relayed.length,
    openRelayedStreams: relayed.filter((stream) => !stream.closed).length,
    relayedFiltersNameLeaf: relayed.every((stream) => stream.relayedNodes.includes(leafNodeId)),
    mainFrames: mainFrames.length,
    mainRelayedFrames: mainFrames.filter(isRelayedFrame).length,
    mainLegacyFromLeaf: mainFrames.filter(
      (frame) => frame.event === "relayed-node-event" && frame.nodeId === leafNodeId,
    ).length,
    mainLegacyResyncsForLeaf: mainFrames.filter(
      (frame) =>
        frame.event === "relayed-node-event" &&
        frame.nodeId === leafNodeId &&
        frame.relayedKind === "resync",
    ).length,
    relayedFrames: relayedFrames.length,
    relayedFramesFromLeaf: relayedFrames.filter(
      (frame) => frame.event === `relayed-node-event:${leafNodeId}`,
    ).length,
    relayedResyncsForLeaf: relayedFrames.filter(
      (frame) => frame.nodeId === leafNodeId && frame.relayedKind === "resync",
    ).length,
    relayedEventNames: [
      ...new Set(relayedFrames.map((frame) => frame.relayedEvent).filter(Boolean)),
    ].sort(),
  };
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(
    (next) =>
      (
        window as unknown as { __federationQa: { setHidden(next: boolean): void } }
      ).__federationQa.setHidden(next),
    hidden,
  );
}

async function breakStreams(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as { __federationQa: { breakStreams(): number } }
    ).__federationQa.breakStreams(),
  );
}

/** Startup dialogs the credential-free fixture opens, closed for this run only. */
async function dismissDialogs(page: Page): Promise<void> {
  for (const text of [
    "Continue Without Claude",
    "Continue Without GitHub CLI",
    "Continue Without Docker",
    "Continue anyway",
    "Dismiss",
  ]) {
    await page
      .locator(`button:has-text("${text}")`)
      .first()
      .click({ timeout: 500 })
      .catch(() => undefined);
  }
}

async function openPage(context: BrowserContext, profile: string): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(loginUrl(profile));
  await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2_000);
  await dismissDialogs(page);
  return page;
}

/** Shows `name`'s sidebar row, expanding collapsed projects when it is not drawn yet. */
async function revealRow(page: Page, name: string): Promise<void> {
  const row = sidebarEnvironmentRow(page, name);
  await expect(async () => {
    if (!(await row.isVisible())) {
      await dismissDialogs(page);
      const expanders = page.getByRole("button", { name: /^Expand project / });
      for (let index = (await expanders.count()) - 1; index >= 0; index -= 1) {
        await expanders
          .nth(index)
          .click({ timeout: 1_000 })
          .catch(() => undefined);
      }
    }
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: VIEW_TIMEOUT_MS });
}

async function markerState(page: Page, name: string): Promise<string | null> {
  return sidebarEnvironmentRow(page, name)
    .locator('[data-testid="environment-status-marker"]')
    .first()
    .getAttribute("data-state", { timeout: 1_000 })
    .catch(() => null);
}

async function badgeText(page: Page, name: string): Promise<string | null> {
  const badge = sidebarEnvironmentRow(page, name)
    .locator('[data-testid="environment-change-counts"]')
    .first();
  if (!(await badge.isVisible().catch(() => false))) return null;
  return ((await badge.textContent().catch(() => null)) ?? "").replace(/\s+/g, " ").trim();
}

/** When `read` first answers true, polled every 100 ms. */
async function firstSeen(
  label: string,
  read: () => Promise<boolean>,
  timeoutMs = VIEW_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read().catch(() => false)) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function metrics(command: Gateway): Promise<{ main: number; relayed: number }> {
  const response = await fetch(`${command.origin}/__orkestrator/metrics`, {
    headers: { authorization: `Bearer ${command.secret()}`, origin: command.origin },
  });
  expect(response.ok, "the command node's metrics").toBe(true);
  const body = (await response.json()) as {
    replay: { ring: RingStats; relayedRing: RingStats };
  };
  return {
    main: body.replay.ring.latestRevision,
    relayed: body.replay.relayedRing.latestRevision,
  };
}

async function legacyCount(command: Gateway): Promise<number> {
  const usage = await command.invoke<{ paths: Record<string, { count: number } | undefined> }>(
    "get_compatibility_path_usage",
  );
  return usage.paths[LEGACY_COUNTER]?.count ?? 0;
}

async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "federation-two-profile-fake-model.ts")],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const origin = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", () => reject(new Error("the fake model exited before it listened")));
  });
  return { origin, child };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function calls(origin: string): Promise<Calls> {
  return (await (await fetch(`${origin}/__calls`)).json()) as Calls;
}

async function release(origin: string): Promise<void> {
  await fetch(`${origin}/__release`, { method: "POST" });
}

async function setDisplayName(node: Gateway, displayName: string): Promise<void> {
  const profile = await node.invoke<{ revision: number }>("get_backend_profile");
  await node.invoke("update_backend_profile", {
    expectedRevision: profile.revision,
    displayName,
    colorToken: "blue",
  });
}

interface Setup {
  command: Gateway;
  leaf: Gateway;
  leafNodeId: string;
  leafEnvironment: { id: string; name: string; worktreePath: string };
  commandEnvironment: { id: string; name: string };
  identity: Identity;
  model: { origin: string; child: ChildProcess };
  commandContext: BrowserContext;
  leafContext: BrowserContext;
  commandPage: Page;
  leafPage: Page;
  /** Lines appended to the leaf worktree's README so far. */
  appended: number;
  legacyCountAtStart: number;
}

let setup: Setup | null = null;
const cleanup: Array<() => Promise<unknown>> = [];
const summary: Record<string, unknown> = {
  activityLagBudgetMs: ACTIVITY_LAG_BUDGET_MS,
  model: `${PI_PROVIDER}/${FAKE_MODEL_ID}`,
};

function s(): Setup {
  if (!setup) throw new Error("The two-profile setup did not run.");
  return setup;
}

function appendLines(count: number): void {
  const { leafEnvironment } = s();
  let lines = "";
  for (let index = 0; index < count; index += 1) {
    lines += `federation two-profile line ${s().appended + index + 1}\n`;
  }
  appendFileSync(path.join(leafEnvironment.worktreePath, "README.md"), lines);
  s().appended += count;
}

/** The leaf's own window and the command node's row show the same badge, with every line counted. */
async function expectBadgeParity(page: Page, label: string): Promise<string> {
  const { leafPage, leafEnvironment, appended } = s();
  let matched = "";
  await expect
    .poll(
      async () => {
        const leafBadge = await badgeText(leafPage, leafEnvironment.name);
        const remoteBadge = await badgeText(page, leafEnvironment.name);
        matched = remoteBadge ?? "";
        return (
          leafBadge !== null &&
          leafBadge === remoteBadge &&
          new RegExp(`\\+${appended}(?!\\d)`).test(remoteBadge)
        );
      },
      { timeout: VIEW_TIMEOUT_MS, intervals: [250], message: `badge parity (${label})` },
    )
    .toBe(true);
  return matched;
}

async function dispatchHeldTurn(label: string): Promise<number> {
  const { leaf, identity, model } = s();
  const heldBefore = (await calls(model.origin)).heldTotal;
  const dispatchedAt = Date.now();
  await leaf.invoke("dispatch_native_agent_prompt", {
    ...identity,
    prompt: `Wait for the test to release you. ${HOLD_MARKER}`,
    requestId: `federation-${label}-${Date.now()}`,
    model: MODEL_REF,
  });
  await expect
    .poll(async () => (await calls(model.origin)).heldTotal, {
      timeout: 180_000,
      message: `the ${label} turn never reached the fake model`,
    })
    .toBe(heldBefore + 1);
  return dispatchedAt;
}

async function leafActivity(): Promise<string> {
  const { leaf, leafEnvironment } = s();
  const environment = await leaf.invoke<{ agentActivityState?: string }>("get_environment", {
    environmentId: leafEnvironment.id,
  });
  return environment.agentActivityState ?? "idle";
}

/** When the leaf's backend, its own row and the command node's row each first show `state`. */
async function observeTransition(page: Page, state: "working" | "idle", startedAt: number) {
  const { leafPage, leafEnvironment } = s();
  const [backendAt, leafRowAt, commandRowAt] = await Promise.all([
    firstSeen(`leaf backend ${state}`, async () => (await leafActivity()) === state),
    firstSeen(
      `leaf row ${state}`,
      async () => (await markerState(leafPage, leafEnvironment.name)) === state,
    ),
    firstSeen(
      `command row ${state}`,
      async () => (await markerState(page, leafEnvironment.name)) === state,
    ),
  ]);
  return {
    state,
    backendMs: backendAt - startedAt,
    leafRowMs: leafRowAt - startedAt,
    commandRowMs: commandRowAt - startedAt,
    commandBehindBackendMs: commandRowAt - backendAt,
    commandBehindLeafRowMs: commandRowAt - leafRowAt,
  };
}

async function openContext(browser: Browser, record: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fetchModulesOutsideChromium(context);
  if (record) await context.addInitScript(installStreamRecorder);
  return context;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(900_000);
  const command = gateway(commandProfile);
  const leaf = gateway(leafProfile);
  const model = await startFakeModel();
  cleanup.push(() => stopChild(model.child));
  cleanup.push(() => release(model.origin).catch(() => undefined));
  const restorePi = pointPiAt(profileStatus(leafProfile), `${model.origin}/v1`, {
    id: PI_PROVIDER,
    name: "Federation two-profile fake",
    model: FAKE_MODEL_ID,
    modelName: "Federation hold 1",
    apiKey: "federation-fake-not-a-key",
  });
  cleanup.push(async () => restorePi());
  await setDisplayName(command, COMMAND_NAME);
  await setDisplayName(leaf, LEAF_NAME);
  const { nodeId: leafNodeId } = await attachLeaf(command, leaf);
  cleanup.push(() => command.invoke("forget_node", { nodeId: leafNodeId }).catch(() => undefined));
  const stamp = Date.now().toString(36);
  const commandEnvironmentName = `fed-cmd-${stamp}`;
  const leafEnvironmentName = `fed-leaf-${stamp}`;
  const commandEnvironment = await createLeafEnvironment(command, commandEnvironmentName);
  cleanup.push(() =>
    command.invoke("delete_environment", { environmentId: commandEnvironment.id }).catch(() => 0),
  );
  const leafEnvironment = await createLeafEnvironment(leaf, leafEnvironmentName);
  cleanup.push(() =>
    leaf.invoke("delete_environment", { environmentId: leafEnvironment.id }).catch(() => 0),
  );
  const layout = await leaf.invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: leafEnvironment.id,
  });
  await leaf.invoke("save_pane_layout", {
    environmentId: leafEnvironment.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-federation-two-profile",
      root: {
        kind: "leaf",
        id: "pane-federation-two-profile",
        activeTabId: LEAF_TAB,
        tabs: [
          {
            id: LEAF_TAB,
            type: "agent-native",
            nativeAgentData: { environmentId: leafEnvironment.id, platform: "pi", isLocal: true },
            initialAgentModel: MODEL_REF,
          },
        ],
      },
    },
  });
  const identity: Identity = {
    environmentId: leafEnvironment.id,
    agent: "pi",
    logicalSessionKey: `env-${leafEnvironment.id}:${LEAF_TAB}`,
  };
  await leaf.invoke("ensure_native_agent_session", { ...identity, model: MODEL_REF });
  const legacyCountAtStart = await legacyCount(command);

  const commandContext = await openContext(browser, true);
  cleanup.push(() => commandContext.close().catch(() => undefined));
  const leafContext = await openContext(browser, false);
  cleanup.push(() => leafContext.close().catch(() => undefined));
  const commandPage = await openPage(commandContext, commandProfile);
  const leafPage = await openPage(leafContext, leafProfile);
  await revealRow(commandPage, leafEnvironmentName);
  await revealRow(commandPage, commandEnvironmentName);
  await revealRow(leafPage, leafEnvironmentName);
  setup = {
    command,
    leaf,
    leafNodeId,
    leafEnvironment: {
      id: leafEnvironment.id,
      name: leafEnvironmentName,
      worktreePath: leafEnvironment.worktreePath!,
    },
    commandEnvironment: { id: commandEnvironment.id, name: commandEnvironmentName },
    identity,
    model,
    commandContext,
    leafContext,
    commandPage,
    leafPage,
    appended: 0,
    legacyCountAtStart,
  };
  summary.topology = { leafNodeId, platforms: ["pi"] };
});

test.afterAll(async () => {
  if (setup) summary.calls = await calls(setup.model.origin).catch(() => null);
  mkdirSync(SUMMARY_DIR, { recursive: true });
  writeFileSync(path.join(SUMMARY_DIR, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  cleanup.length = 0;
  setup = null;
});

test("a remote row's activity keeps up with the leaf's own row (2190 task 3)", async () => {
  test.setTimeout(900_000);
  const { commandPage, leafPage, leafEnvironment, model } = s();
  // Both views start from the same idle state.
  await expect.poll(() => markerState(leafPage, leafEnvironment.name)).toBe("idle");
  await expect.poll(() => markerState(commandPage, leafEnvironment.name)).toBe("idle");
  const transitions: Array<Awaited<ReturnType<typeof observeTransition>>> = [];
  for (let cycle = 1; cycle <= ACTIVITY_CYCLES; cycle += 1) {
    const dispatchedAt = await dispatchHeldTurn(`activity-${cycle}`);
    transitions.push(await observeTransition(commandPage, "working", dispatchedAt));
    const label = await sidebarEnvironmentRow(commandPage, leafEnvironment.name).getAttribute(
      "aria-label",
    );
    expect(label, "the remote row announces the leaf and its activity").toMatch(
      new RegExp(`, on ${LEAF_NAME}, Working$`),
    );
    const releasedAt = Date.now();
    await release(model.origin);
    transitions.push(await observeTransition(commandPage, "idle", releasedAt));
  }
  summary.activity = {
    transitions,
    commandBehindBackend: lagSummary(transitions.map((step) => step.commandBehindBackendMs)),
    commandBehindLeafRow: lagSummary(transitions.map((step) => step.commandBehindLeafRowMs)),
  };
  for (const step of transitions) {
    expect(
      step.commandBehindBackendMs,
      `the command node's row reached ${step.state} within the budget`,
    ).toBeLessThanOrEqual(ACTIVITY_LAG_BUDGET_MS);
  }
});

test("relayed events arrive per node with a busy leaf and an inactive tab (5840 task 1)", async () => {
  test.setTimeout(900_000);
  const { command, commandPage, leafEnvironment, leafNodeId, model } = s();
  const before = await metrics(command);
  appendLines(3);
  const first = await expectBadgeParity(commandPage, "first change");

  // A busy leaf: a flood of file changes, each one a projection event there.
  const floodStart = await metrics(command);
  for (let index = 0; index < FLOOD_WRITES; index += 1) {
    appendLines(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  const flooded = await expectBadgeParity(commandPage, "after the flood");
  const floodEnd = await metrics(command);
  const busy = await streamFacts(commandPage, leafNodeId);
  const flood = {
    writes: FLOOD_WRITES,
    mainRingDelta: floodEnd.main - floodStart.main,
    relayedRingDelta: floodEnd.relayed - floodStart.relayed,
  };
  expect(busy.mainRelayedFrames, "the main stream carries no relayed frame").toBe(0);
  expect(busy.relayedStreams, "a relayed stream was opened").toBeGreaterThan(0);
  expect(busy.relayedFiltersNameLeaf, "every relayed stream's filter names the leaf").toBe(true);
  expect(
    busy.relayedFramesFromLeaf,
    "the leaf's events came on the relayed stream",
  ).toBeGreaterThan(0);
  expect(flood.relayedRingDelta, "the relayed ring moved under the flood").toBeGreaterThan(0);
  expect(
    flood.mainRingDelta,
    "the main ring moved far less than the relayed ring under the flood",
  ).toBeLessThan(flood.relayedRingDelta);

  // The window switches to its own environment, then the tab goes away:
  // hidden, offline, its streams dropped. Meanwhile the leaf changes and
  // starts a turn.
  await sidebarEnvironmentRow(commandPage, s().commandEnvironment.name).click();
  const streamsBeforeAway = (await recordedStreams(commandPage)).length;
  await setHidden(commandPage, true);
  await s().commandContext.setOffline(true);
  const dropped = await breakStreams(commandPage);
  appendLines(5);
  const awayDispatchedAt = await dispatchHeldTurn("away");
  await expect.poll(() => leafActivity(), { timeout: VIEW_TIMEOUT_MS }).toBe("working");
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await s().commandContext.setOffline(false);
  await setHidden(commandPage, false);
  const returnedAt = Date.now();
  const back = await expectBadgeParity(commandPage, "back from away");
  const backBadgeMs = Date.now() - returnedAt;
  await expect
    .poll(() => markerState(commandPage, leafEnvironment.name), { timeout: VIEW_TIMEOUT_MS })
    .toBe("working");
  const backActivityMs = Date.now() - returnedAt;
  const afterReturn = await streamFacts(commandPage, leafNodeId);
  expect(
    (await recordedStreams(commandPage)).length,
    "the tab reopened its streams",
  ).toBeGreaterThan(streamsBeforeAway);
  expect(afterReturn.openRelayedStreams, "a relayed stream is open again").toBeGreaterThan(0);
  expect(afterReturn.mainRelayedFrames).toBe(0);

  // Released while the tab is back, then a reload rehydrates both.
  await release(model.origin);
  await expect
    .poll(() => markerState(commandPage, leafEnvironment.name), { timeout: VIEW_TIMEOUT_MS })
    .toBe("idle");
  await commandPage.reload();
  await expect(commandPage.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  await dismissDialogs(commandPage);
  await revealRow(commandPage, leafEnvironment.name);
  const reloaded = await expectBadgeParity(commandPage, "after reload");
  await expect
    .poll(() => markerState(commandPage, leafEnvironment.name), { timeout: VIEW_TIMEOUT_MS })
    .toBe("idle");
  const afterReload = await streamFacts(commandPage, leafNodeId);
  expect(afterReload.mainRelayedFrames).toBe(0);
  expect(afterReload.relayedFiltersNameLeaf).toBe(true);
  const after = await metrics(command);
  summary.relayed = {
    badges: { first, flooded, back, reloaded },
    flood,
    busyStreams: busy,
    away: {
      droppedStreams: dropped,
      awayTurnDispatchedMsBeforeReturn: returnedAt - awayDispatchedAt,
      backBadgeMs,
      backActivityMs,
      streams: afterReturn,
    },
    afterReload,
    rings: { mainDelta: after.main - before.main, relayedDelta: after.relayed - before.relayed },
    legacyCounterDelta: (await legacyCount(command)) - s().legacyCountAtStart,
  };
  expect(
    (await legacyCount(command)) - s().legacyCountAtStart,
    "no stream took the legacy relayed name while every client asked for per-node names",
  ).toBe(0);
});

test("relayed events still arrive for an older peer, under the one old name (5840 task 2)", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { command, commandPage, leafEnvironment, leafNodeId } = s();
  const counterBefore = await legacyCount(command);
  const legacyContext = await openContext(browser, true);
  cleanup.push(() => legacyContext.close().catch(() => undefined));
  const rewrites = { mainStreams: 0, watchAnswers: 0 };
  // What an older renderer sends, and what an older command node sees of a
  // current renderer's request: the main stream without `relayedEvents`.
  await legacyContext.route(
    (url) => url.pathname === "/__orkestrator/events",
    async (route) => {
      const legacy = legacyMainStreamUrl(route.request().url());
      if (!legacy) return route.fallback();
      rewrites.mainStreams += 1;
      return route.continue({ url: legacy });
    },
  );
  // And what an older command node answers: no `perNodeEvents`.
  await legacyContext.route(
    (url) => url.pathname === "/__orkestrator/invoke",
    async (route) => {
      let command: unknown;
      try {
        command = (JSON.parse(route.request().postData() ?? "{}") as { command?: unknown }).command;
      } catch {
        command = undefined;
      }
      if (command !== "watch_node_events") return route.fallback();
      const response = await route.fetch();
      const body = (await response.json().catch(() => null)) as unknown;
      rewrites.watchAnswers += 1;
      return route.fulfill({
        status: response.status(),
        headers: decodedBodyHeaders(response.headers()),
        body: JSON.stringify(withoutPerNodeEvents(command, body)),
      });
    },
  );
  const legacyPage = await openPage(legacyContext, commandProfile);
  await revealRow(legacyPage, leafEnvironment.name);
  appendLines(2);
  const live = await expectBadgeParity(legacyPage, "older peer, live");
  await expectBadgeParity(commandPage, "per-node page beside the older peer");
  await expect
    .poll(async () => (await streamFacts(legacyPage, leafNodeId)).mainLegacyFromLeaf, {
      timeout: VIEW_TIMEOUT_MS,
      message: "the leaf's events arrived under the old name",
    })
    .toBeGreaterThan(0);
  const beforeReconnect = await streamFacts(legacyPage, leafNodeId);

  // A reconnect: the leaf changes while the page is offline, so the main
  // stream's replay must tell it to re-read the leaf.
  await legacyContext.setOffline(true);
  const dropped = await breakStreams(legacyPage);
  appendLines(2);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await legacyContext.setOffline(false);
  const reconnected = await expectBadgeParity(legacyPage, "older peer, after reconnect");
  await expect
    .poll(async () => (await streamFacts(legacyPage, leafNodeId)).mainLegacyResyncsForLeaf, {
      timeout: VIEW_TIMEOUT_MS,
      message: "a resync for the leaf arrived under the old name",
    })
    .toBeGreaterThan(beforeReconnect.mainLegacyResyncsForLeaf);
  const legacyStreams = await streamFacts(legacyPage, leafNodeId);
  const perNodeStreams = await streamFacts(commandPage, leafNodeId);
  const counterAfter = await legacyCount(command);
  summary.olderPeer = {
    rewrites,
    droppedStreams: dropped,
    badges: { live, reconnected },
    legacyStreams,
    perNodeStreamsBeside: perNodeStreams,
    legacyCounterDelta: counterAfter - counterBefore,
  };
  expect(rewrites.mainStreams, "the older peer's main stream was opened").toBeGreaterThan(0);
  expect(rewrites.watchAnswers, "the older peer's watch was answered").toBeGreaterThan(0);
  expect(legacyStreams.relayedStreams, "an older peer opens no relayed stream").toBe(0);
  expect(perNodeStreams.mainRelayedFrames, "the per-node page's main stream stays clean").toBe(0);
  expect(counterAfter, "the legacy-stream counter moved for the older peer").toBeGreaterThan(
    counterBefore,
  );
  await legacyContext.close();
});
