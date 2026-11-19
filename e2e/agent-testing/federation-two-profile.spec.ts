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
 *   page's streams are recorded (an init script wraps `EventSource`, and
 *   `frameFacts` reduces each frame to names, node ids and kinds before
 *   anything is compared or written). The main stream must carry no
 *   relayed frame, a relayed stream must name the leaf, and under a flood of
 *   leaf file changes the relayed ring must move while the main ring barely
 *   does. Then the tab goes away (hidden, offline, streams dropped) while the
 *   leaf changes and starts a turn; back again, and after a reload, the
 *   remote row's change badge and activity must match the leaf's own row.
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
  frameFacts,
  isRelayedFrame,
  lagSummary,
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
/** How long a dispatched turn may take to reach the fake model (a cold Pi start included). */
const DISPATCH_TIMEOUT_MS = 180_000;
const LEAF_NAME = "Leaf two-profile";
const COMMAND_NAME = "Command two-profile";
const LEAF_TAB = "federation-two-profile-pi";

type Identity = { environmentId: string; agent: "pi"; logicalSessionKey: string };
type Calls = { completions: number; refused: number; heldTotal: number; held: number };
/** A stream as the page recorded it: raw `data` fields, bounded, never written anywhere. */
type PageStream = { url: string; total: number; data: string[]; closed: boolean };
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
 * Runs in every page before the app: records each `EventSource` and the raw
 * `data` of its frames (bounded by count and bytes), and lets the spec hide
 * the document and drop every stream. The spec reduces the data with the
 * unit-tested `frameFacts` (`recordedStreams`), so the raw strings stay in
 * page and test memory and never reach an artifact. Self-contained, because
 * Playwright serialises it into the page.
 */
function installStreamRecorder(): void {
  type Stream = { url: string; total: number; data: string[]; closed: boolean };
  const MAX_FRAMES = 4_000;
  const MAX_BYTES = 16 * 1024 * 1024;
  let bytes = 0;
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
      const stream: Stream = { url: String(url), total: 0, data: [], closed: false };
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
                // Past either bound a frame is counted only.
                if (stream.data.length < MAX_FRAMES && bytes + message.data.length <= MAX_BYTES) {
                  bytes += message.data.length;
                  stream.data.push(message.data);
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

/** A page's streams, each frame reduced by `frameFacts`; frames that are not gateway frames are dropped. */
async function recordedStreams(page: Page): Promise<RecordedStream[]> {
  const streams = await page.evaluate(() =>
    (window as unknown as { __federationQa: { streams: PageStream[] } }).__federationQa.streams.map(
      (stream) => ({ ...stream, data: [...stream.data] }),
    ),
  );
  return streams.map(({ data, ...stream }) => ({
    ...stream,
    frames: data.map(frameFacts).filter((facts): facts is FrameFacts => facts !== null),
  }));
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
    // False with no relayed stream at all, so an empty list never passes.
    relayedFiltersNameLeaf:
      relayed.length > 0 && relayed.every((stream) => stream.relayedNodes.includes(leafNodeId)),
    mainFrames: mainFrames.length,
    mainRelayedFrames: mainFrames.filter(isRelayedFrame).length,
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
    "Continue without Claude",
    "Continue without GitHub CLI",
    "Continue without Docker",
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
      timeout: DISPATCH_TIMEOUT_MS,
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

/**
 * When the leaf's backend, its own row and the command node's row each first
 * show `state`. Call it while all three still show the other state and
 * before the action that changes it (`whileObserving`), so no transition can
 * happen before the polls are running.
 */
async function observeTransition(
  page: Page,
  state: "working" | "idle",
  startedAt: number,
  timeoutMs = VIEW_TIMEOUT_MS,
) {
  const { leafPage, leafEnvironment } = s();
  const [backendAt, leafRowAt, commandRowAt] = await Promise.all([
    firstSeen(`leaf backend ${state}`, async () => (await leafActivity()) === state, timeoutMs),
    firstSeen(
      `leaf row ${state}`,
      async () => (await markerState(leafPage, leafEnvironment.name)) === state,
      timeoutMs,
    ),
    firstSeen(
      `command row ${state}`,
      async () => (await markerState(page, leafEnvironment.name)) === state,
      timeoutMs,
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

/**
 * Arms the observers for `state`, then runs `action` (the dispatch or the
 * release) alongside them, and resolves with both once the transition is
 * seen everywhere and the action has finished.
 */
async function whileObserving(
  page: Page,
  state: "working" | "idle",
  action: () => Promise<unknown>,
  timeoutMs?: number,
) {
  const startedAt = Date.now();
  const [step] = await Promise.all([
    observeTransition(page, state, startedAt, timeoutMs),
    action(),
  ]);
  return step;
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

test("a remote row's activity keeps up with the leaf's own row (#2212)", async () => {
  test.setTimeout(900_000);
  const { commandPage, leafPage, leafEnvironment, model } = s();
  // Both views start from the same idle state.
  await expect.poll(() => markerState(leafPage, leafEnvironment.name)).toBe("idle");
  await expect.poll(() => markerState(commandPage, leafEnvironment.name)).toBe("idle");
  const transitions: Array<Awaited<ReturnType<typeof observeTransition>>> = [];
  for (let cycle = 1; cycle <= ACTIVITY_CYCLES; cycle += 1) {
    // Observers are armed while every view is idle, before the dispatch, and
    // the first cold Pi start may take as long as the dispatch's own wait.
    transitions.push(
      await whileObserving(
        commandPage,
        "working",
        () => dispatchHeldTurn(`activity-${cycle}`),
        DISPATCH_TIMEOUT_MS,
      ),
    );
    const label = await sidebarEnvironmentRow(commandPage, leafEnvironment.name).getAttribute(
      "aria-label",
    );
    expect(label, "the remote row announces the leaf and its activity").toMatch(
      new RegExp(`, on ${LEAF_NAME}, Working$`),
    );
    transitions.push(await whileObserving(commandPage, "idle", () => release(model.origin)));
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

test("relayed events arrive per node with a busy leaf and an inactive tab (#2212)", async () => {
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
  // The reload must reopen the relayed path, not merely leave nothing to check.
  await expect
    .poll(async () => (await streamFacts(commandPage, leafNodeId)).openRelayedStreams, {
      timeout: VIEW_TIMEOUT_MS,
      message: "a relayed stream reopened after the reload",
    })
    .toBeGreaterThan(0);
  const afterReload = await streamFacts(commandPage, leafNodeId);
  expect(afterReload.relayedStreams, "the reloaded page opened a relayed stream").toBeGreaterThan(
    0,
  );
  expect(afterReload.mainRelayedFrames).toBe(0);
  expect(afterReload.relayedFiltersNameLeaf, "every relayed stream's filter names the leaf").toBe(
    true,
  );
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
  };
});

test("the phone palette opens the shown leaf's Files panel", async () => {
  const { commandPage, leafEnvironment, leafNodeId } = s();
  const desktop = commandPage.viewportSize()!;
  await sidebarEnvironmentRow(commandPage, leafEnvironment.name).click();
  const remote = commandPage.getByTestId("remote-workspace-region");
  await expect(remote).toHaveAttribute("data-node", leafNodeId);
  await commandPage.setViewportSize({ width: 390, height: 844 });
  try {
    appendLines(1);
    for (const [query, tabName] of [
      ["open changes", /^Changes/],
      ["browse files", "All files"],
    ] as const) {
      const drawer = commandPage
        .getByRole("button", {
          name: /^(Open|Close) projects and environments$/,
        })
        .filter({ visible: true })
        .first();
      await expect(drawer).toBeVisible();
      if ((await drawer.getAttribute("aria-expanded")) === "false") await drawer.click();
      await commandPage.getByTestId("project-search-trigger").click();
      const input = commandPage.getByRole("combobox", { name: "Search projects and environments" });
      await input.fill(query);
      const action = commandPage.getByRole("option", { name: new RegExp(query, "i") });
      await expect(action).toHaveAccessibleName(new RegExp(LEAF_NAME));
      await action.click();

      const files = commandPage.getByRole("complementary", { name: "Workspace files" });
      await expect(files.getByRole("tab", { name: tabName })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(files.getByText("README.md", { exact: true })).toBeVisible();
      await files.screenshot({
        path: path.join(
          repositoryRoot,
          "output/visual-previews",
          `palette-remote-${query.replace(" ", "-")}-390.png`,
        ),
      });
      await files.getByRole("button", { name: "Close panel" }).click();
      await expect(files).toBeHidden();
    }
  } finally {
    await commandPage.setViewportSize(desktop);
  }
});

test("past sessions refuse a disconnected owner and resume durably after reconnect", async () => {
  test.setTimeout(240_000);
  const { command, commandPage, leaf, leafEnvironment, leafNodeId, identity } = s();
  const past = { ...identity, logicalSessionKey: `env-${leafEnvironment.id}:past-palette-fixture` };
  const prompt = "Create a conversation to resume from the command palette.";
  await leaf.invoke("ensure_native_agent_session", { ...past, model: MODEL_REF });
  await leaf.invoke("dispatch_native_agent_prompt", {
    ...past,
    prompt,
    requestId: `federation-palette-past-${Date.now()}`,
    model: MODEL_REF,
  });
  const projection = (logicalSessionKey: string) =>
    leaf.invoke<{ turn?: { phase?: string }; messages?: Array<{ content?: unknown }> } | null>(
      "get_native_agent_projection",
      { ...identity, logicalSessionKey },
    );
  await expect
    .poll(async () => (await projection(past.logicalSessionKey))?.turn?.phase, {
      timeout: VIEW_TIMEOUT_MS,
    })
    .toBe("idle");
  // Pi's resume handle is the provider's list entry, not the bridge's live ID.
  const list = () =>
    leaf.invoke<Array<{ sessionId: string; detail?: string }>>(
      "list_native_agent_resumable_sessions",
      identity,
    );
  await expect.poll(async () => (await list()).some((entry) => entry.detail === prompt)).toBe(true);
  const sessionId = (await list()).find((entry) => entry.detail === prompt)!.sessionId;

  await revealRow(commandPage, leafEnvironment.name);
  await sidebarEnvironmentRow(commandPage, leafEnvironment.name).click();
  await expect(commandPage.getByTestId("remote-workspace-region")).toHaveAttribute(
    "data-node",
    leafNodeId,
  );
  const openHistory = async () => {
    await commandPage.getByTestId("project-search-trigger").click();
    const input = commandPage.getByRole("combobox", { name: "Search projects and environments" });
    await input.press("Alt+ArrowUp");
    return input;
  };
  const layout = () =>
    leaf.invoke<{
      root: { tabs: Array<{ id: string; nativeAgentData?: { sessionId?: string } }> };
    }>("get_pane_layout", { environmentId: leafEnvironment.id });
  const before = (await layout()).root.tabs.map(({ id }) => id);
  const input = await openHistory();
  const result = commandPage.getByTestId(`command-palette-session-${sessionId}`);
  await expect(result).toBeVisible({ timeout: VIEW_TIMEOUT_MS });
  const rowId = await result.getAttribute("id");
  for (let index = 0; index < (await commandPage.getByRole("option").count()); index++) {
    if ((await input.getAttribute("aria-activedescendant")) === rowId) break;
    await input.press("ArrowDown");
  }
  await expect(input).toHaveAttribute("aria-activedescendant", rowId!);

  await command.invoke("update_node", { nodeId: leafNodeId, enabled: false });
  try {
    await expect(result).toHaveCount(0, { timeout: VIEW_TIMEOUT_MS });
    await input.press("Enter");
    expect((await layout()).root.tabs.map(({ id }) => id)).toEqual(before);
  } finally {
    await command.invoke("update_node", { nodeId: leafNodeId, enabled: true });
  }
  await expect(result).toBeVisible({ timeout: VIEW_TIMEOUT_MS });
  await result.click();
  const resumedTab = async () =>
    (await layout()).root.tabs.find(
      (tab) => !before.includes(tab.id) && tab.nativeAgentData?.sessionId,
    );
  await expect
    .poll(async () => Boolean(await resumedTab()), { timeout: VIEW_TIMEOUT_MS })
    .toBe(true);
  const { id: tabId } = (await resumedTab())!;
  const resumed = await projection(`env-${leafEnvironment.id}:${tabId}`);
  expect(resumed?.messages?.some((message) => message.content === prompt)).toBe(true);

  await commandPage.reload();
  await revealRow(commandPage, leafEnvironment.name);
  await sidebarEnvironmentRow(commandPage, leafEnvironment.name).click();
  const reloadedHistory = await openHistory();
  await expect(commandPage.getByTestId(`command-palette-history-${tabId}`)).toBeVisible({
    timeout: VIEW_TIMEOUT_MS,
  });
  await reloadedHistory.press("Escape");
  await expect(reloadedHistory).toBeHidden();
});

test("the project toolbar switches Home to the leaf and Pull requests back to the command node", async () => {
  const { command, leaf, commandPage: page, leafNodeId } = s();
  const findCopy = async (node: Gateway) => {
    const { testProject } = profileStatus(node.profile);
    const projects =
      await node.invoke<Array<{ id: string; name: string; gitUrl: string; localPath: string }>>(
        "get_projects",
      );
    const project = projects.find((entry) => entry.localPath === testProject);
    if (!project) throw new Error(`${node.profile} has no fixture project`);
    return { node, project };
  };
  const [local, peer] = await Promise.all([findCopy(command), findCopy(leaf)]);
  expect(local.project.id).not.toBe(peer.project.id);

  const remote = page.getByTestId("remote-workspace-region");
  const remoteBar = remote.getByTestId("project-navigation-bar");
  const localBar = page.getByTestId("project-navigation-bar").filter({
    has: page.getByRole("combobox", { name: "Machine" }).filter({ hasText: COMMAND_NAME }),
  });
  const openCopy = async (projectName: string, machineName: string) => {
    await page.getByTestId("project-search-trigger").click();
    await page
      .getByRole("combobox", { name: "Search projects and environments" })
      .fill(projectName);
    await page
      .getByRole("option", { name: `${projectName}, project on ${machineName}`, exact: true })
      .click();
  };

  // Both profiles are reset by the suite. The shared URL is used only for repository identity.
  for (const { node, project } of [local, peer]) {
    await node.invoke("update_project", {
      projectId: project.id,
      updates: { gitUrl: "https://example.test/fixtures/machine-switch.git" },
    });
  }

  // Remember Notes on the same leaf scope that will handle the switch.
  await openCopy(peer.project.name, LEAF_NAME);
  await expect(remote).toHaveAttribute("data-node", leafNodeId);
  const notes = remoteBar.getByRole("tab", { name: "Notes", exact: true });
  await notes.click();
  await expect(notes).toHaveAttribute("aria-selected", "true");
  await openCopy(local.project.name, COMMAND_NAME);
  await expect(remote).toBeHidden();
  await localBar.getByRole("tab", { name: "Home", exact: true }).click();
  await expect(page.locator("#project-panel-home").filter({ visible: true })).toBeVisible();
  await localBar.getByRole("combobox", { name: "Machine" }).click();
  await page.getByRole("option", { name: LEAF_NAME, exact: true }).click();

  await expect(remote).toHaveAttribute("data-node", leafNodeId);
  await expect(remoteBar.getByRole("tab", { name: "Home", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(remote.locator("#project-panel-home")).toBeVisible();
  await expect(remoteBar.getByRole("combobox", { name: "Machine" })).toHaveText(LEAF_NAME);

  await remoteBar.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await expect(remote.locator("#project-panel-pull-requests")).toBeVisible();
  await remoteBar.getByRole("combobox", { name: "Machine" }).click();
  await page.getByRole("option", { name: COMMAND_NAME, exact: true }).click();
  await expect(remote).toBeHidden();
  await expect(localBar.getByRole("tab", { name: "Pull requests", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator("#project-panel-pull-requests").filter({ visible: true }),
  ).toBeVisible();
  await page.reload();
  await expect(localBar.getByRole("tab", { name: "Pull requests", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Settings offers explicit recovery after its last leaf is removed", async () => {
  const { command, commandPage, leafEnvironment, leafNodeId } = s();
  await revealRow(commandPage, leafEnvironment.name);
  await sidebarEnvironmentRow(commandPage, leafEnvironment.name).click();
  await expect(commandPage.getByTestId("remote-workspace-region")).toHaveAttribute(
    "data-node",
    leafNodeId,
  );
  await commandPage.getByTestId("project-search-trigger").click();
  await commandPage
    .getByRole("combobox", { name: "Search projects and environments" })
    .fill("allowlist");
  await commandPage.getByTestId("command-palette-item-settings.network").click();
  await expect(commandPage.getByTestId("settings-scope")).toContainText(
    `Machine settings for ${LEAF_NAME}`,
  );
  await command.invoke("forget_node", { nodeId: leafNodeId });

  const warning = commandPage.getByText("The selected machine is no longer available.");
  const recover = commandPage.getByRole("button", { name: "Use the command machine" });
  await expect(warning).toBeVisible();
  await expect(recover).toBeVisible();
  await recover.locator("..").screenshot({
    path: path.join(repositoryRoot, "output/visual-previews/palette-settings-owner-recovery.png"),
  });
  await recover.click();
  await expect(warning).toBeHidden();
});
