/**
 * A steer that misses its turn, and a stop after several turns, on the real
 * bridges with scripted models (todo 0005 task 10, "Needs verification" in
 * docs/todo/agent-engines/0005-mid-turn-steer-and-interrupt.md).
 *
 * One case per platform with steer (Claude, Codex, Cursor, Pi), each on a
 * fresh local fixture environment with one native tab, driven through the
 * backend commands the composer uses (`dispatch_native_agent_intent`,
 * `perform_native_agent_session_action` with a `steer`, the composer's own
 * route for `/steer`):
 *
 * 1. **Missed turn.** A first turn runs to the end. A steer sent after it (a
 *    stale composer that still showed the turn running) must come back
 *    `applied` with `deliveredAs: "new-turn"` and start exactly one new turn:
 *    one user row carrying the steer's text, its reply, nothing left in the
 *    queue, and the session's model, mode and approval mode unchanged. A
 *    second read of the backend's snapshot (what a reload reads) must show
 *    the same.
 * 2. **Replaced turn.** A second, long turn has replaced the first when the
 *    next steer arrives. The backend reads the running turn just before it
 *    steers, so the steer is sent into the turn that is running now and the
 *    bridge accepts it: `applied` (Pi: `unknown` until its next model step
 *    takes the steer, then reconciled), no `deliveredAs`, no queue row, at
 *    most one copy of the text. This pins today's behaviour; binding a composer steer
 *    to the turn the user saw is to-do 8107.
 *
 * And one Claude case for the stop after several turns: a background task is
 * started, two follow-ups are written into the same warm CLI (its runtime
 * generation must not change), then the task is stopped: the stop must
 * succeed and the task's snapshot settle. The CLI is then released by a
 * launch-only change (leaving bypass mode), the next turn runs on a new CLI,
 * and a stop for the task the old CLI owned must be refused with the bridge's
 * `no_control_channel` answer (HTTP 409).
 *
 * The models:
 * - Claude: the profile's real Claude CLI and bridge on the scripted loopback
 *   Anthropic endpoint (`idle-observation-fake-claude.ts`).
 * - Codex: the profile's real Codex app-server and bridge on the scripted
 *   Responses endpoint (`idle-observation-fake-codex.ts`), with a made-up API
 *   key written to the profile's own Codex home and removed afterwards.
 * - Pi: the real Pi bridge and SDK on the scripted chat-completions endpoint
 *   (`idle-observation-fake-pi.ts`), a provider added to the profile's own
 *   Pi `models.json`.
 * - Cursor: the real backend and Cursor bridge over the bridge's fake SDK,
 *   swapped in for the bridge entry for the length of the case
 *   (`steer-inactive-live-support.ts`).
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_MISSED_STEER=1`) against a
 * credential-free profile; `ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS`
 * narrows the platforms. No login is used and nothing is billed:
 *
 *   mise run dev:test --profile msteer10 --fixture --no-agent-credentials --no-host-seed \
 *     --agent-platforms claude,codex,cursor,pi --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=msteer10 ORKESTRATOR_AGENT_TEST_LIVE_MISSED_STEER=1 \
 *     mise run test:logged -- --name steer-missed -- mise run test:agent:browser -- \
 *     e2e/agent-testing/steer-missed-live.spec.ts
 *
 * Evidence (outcomes, counts, generations; never prompt or reply text) goes
 * to `output/agent-testing/<run>/steer-missed/<case>.json`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { expect, test, type Page } from "./browser-test";
import { waitForGatewayRenderer } from "./gateway-renderer-ready";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { startLocalFakeModel } from "./idle-observation-fake-models";
import { PI_FAKE_MODEL_REF } from "./idle-observation-fake-pi";
import { dispatchProbeTurn, requestErrorMessage } from "./mcp-apply-live-support";
import {
  bundleHostFakeCursorBridge,
  cursorBridgeEntry,
  fakeCursorTurns,
  steersCarrying,
  swapBridgeEntry,
} from "./steer-inactive-live-support";
import {
  backgroundTaskPrompt,
  backgroundTaskSettled,
  composerControls,
  isNoControlChannelRefusal,
  longTurnPrompt,
  messageText,
  MISSED_STEER_LABELS,
  MISSED_STEER_PLATFORMS,
  replyPrompt,
  rowsCarrying,
  selectedMissedSteerPlatforms,
  type MissedSteerPlatform,
  type TranscriptMessage,
} from "./steer-missed-live-support";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type ApprovalMode = { id: string; kind?: string };
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: TranscriptMessage[];
  queue?: { items?: unknown[]; inFlightRequestId?: string };
  runtime?: { state?: string; runtimeGeneration?: number };
  runtimeHealthAuthoritative?: boolean;
  recoverableDispatch?: unknown;
  backgroundTasks?: Array<{ id: string; status: string }>;
  composer?: {
    selectedModelId?: string;
    selectedModeId?: string;
    selectedApprovalModeId?: string;
    modes?: Array<{ id: string }>;
    approvalModes?: ApprovalMode[];
  };
};
type SteerOutcome = { outcome: string; deliveredAs?: string; requestId?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type RawInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<{ ok: boolean; text: string }>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "msteer10";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MISSED_STEER === "1";
const SELECTED = LIVE ? selectedMissedSteerPlatforms(process.env) : new Set<string>();
const TURN_TIMEOUT_MS = 180_000;
/** The backend keeps a runtime-health read this long (`INTERACTIVE_RUNTIME_METADATA_TTL_MS`). */
const METADATA_TTL_MS = 30_000;
/**
 * How long a launch-only change may still be refused after the stop. Before
 * the fix (2026-11-14) the bridge waited for a continuation the CLI never
 * sends and refused it for the whole 10-minute idle window.
 */
const RELEASE_WAIT_MS = 60_000;
/** What the scripted models answer a prompt they have no script for (`finalReply`). */
const SCRIPTED_DEFAULT_REPLY = "Done.";
const outputDir = path.join(repositoryRoot, "output", "agent-testing", runId, "steer-missed");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Progress lines keep the logged runner's no-output watchdog quiet. */
const progress = (message: string) => console.log(`[steer-missed] ${message}`);
const word = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;

// Backend calls carry the disposable profile's token; keep it out of traces.
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function signIn(page: Page, status: Status): Promise<{ invoke: Invoke; raw: RawInvoke }> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "load" });
  expect(response?.ok() ?? false).toBe(true);
  await waitForGatewayRenderer(page);
  const raw: RawInvoke = async (name, args = {}) => {
    try {
      const reply = await page.request.post(
        new URL("/__orkestrator/invoke", status.browserUrl!).href,
        {
          data: { command: name, args },
          timeout: 240_000,
        },
      );
      return { ok: reply.ok(), text: await reply.text() };
    } catch (error) {
      throw new Error(requestErrorMessage(name, error));
    }
  };
  const invoke: Invoke = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const reply = await raw(name, args);
    if (!reply.ok) throw new Error(`${name}: ${reply.text.slice(0, 1_000)}`);
    return (JSON.parse(reply.text) as { result: T }).result;
  };
  return { invoke, raw };
}

function writeEvidence(name: string, evidence: Record<string, unknown>): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, `${name}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

/** The platform's scripted-model wiring; the returned function undoes it. */
async function prepareEngine(
  platform: MissedSteerPlatform,
  dataDir: string,
): Promise<() => Promise<void>> {
  if (platform === "cursor") {
    const restore = swapBridgeEntry(
      cursorBridgeEntry(repositoryRoot),
      bundleHostFakeCursorBridge(repositoryRoot),
      dataDir,
    );
    return async () => restore();
  }
  if (platform === "codex") {
    // A made-up API key, so the bridge starts Codex as signed in; only the
    // profile's own Codex home, never the host's.
    const authFile = path.join(dataDir, "agent-credentials", "codex", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
    const restoreAuth = snapshotFixtureFiles([authFile]);
    if (existsSync(authFile)) {
      const auth = JSON.parse(readFileSync(authFile, "utf8")) as { auth_mode?: string };
      if (auth.auth_mode !== "apikey") throw new Error("the profile already has a Codex login");
    }
    writeFileSync(
      authFile,
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-orkestrator-qa-fixture" }),
      { mode: 0o600 },
    );
    try {
      const fake = await startLocalFakeModel("codex", dataDir);
      return async () => {
        try {
          await fake.stop();
        } finally {
          restoreAuth();
        }
      };
    } catch (error) {
      restoreAuth();
      throw error;
    }
  }
  const fake = await startLocalFakeModel(platform, dataDir);
  return () => fake.stop();
}

interface Harness {
  invoke: Invoke;
  raw: RawInvoke;
  identity: { environmentId: string; agent: MissedSteerPlatform; logicalSessionKey: string };
  projection: () => Promise<Projection | null>;
  /** Dispatch as the composer does; the turn's own request id. */
  dispatch: (prompt: string) => Promise<string>;
  /** Wait for the session to read idle with an assistant row carrying one of `markers`. */
  settled: (...markers: string[]) => Promise<Projection>;
  /** The backend's own prompt queue for the tab: where a missed steer waits. */
  promptQueue: () => Promise<{ messages: unknown[]; inFlight?: unknown }>;
  /** Dispatch once; the backend's answer, refusals included. */
  tryDispatch: (prompt: string) => Promise<{ outcome: string; error?: string }>;
  cleanup: () => Promise<void>;
}

/** One fresh local environment with one native tab of `platform`, signed in. */
async function openHarness(
  page: Page,
  platform: MissedSteerPlatform,
  name: string,
): Promise<Harness> {
  const status = profileStatus();
  expect(status.profile).toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor, "runs only in an agent-test profile").toBe("agent-test");
  const { invoke, raw } = await signIn(page, status);
  const enabled = (
    await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>("get_config").catch(() => null)
  )?.global?.enabledAgentPlatforms;
  test.skip(
    enabled !== undefined && !enabled.includes(platform),
    `${MISSED_STEER_LABELS[platform]} is not enabled in profile ${profile}`,
  );
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
  // Before the environment exists, so its bridge's first process reads it.
  const undoEngine = await prepareEngine(platform, status.dataDir!);
  let environmentId: string | undefined;
  let identity: Harness["identity"] | undefined;
  const cleanup = async () => {
    try {
      if (identity) await invoke("stop_native_agent_session", identity).catch(() => undefined);
      if (environmentId) {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
    } finally {
      await undoEngine();
    }
  };
  try {
    const created = await invoke<Environment>("create_environment", {
      projectId: fixture!.id,
      name: `${name}-${platform}-${Date.now()}`,
      environmentType: "local",
    });
    environmentId = created.id;
    await invoke("start_environment", { environmentId });
    const tabId = `${name}-${platform}-tab`;
    const model = platform === "pi" ? PI_FAKE_MODEL_REF : undefined;
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId,
    });
    await invoke("save_pane_layout", {
      environmentId,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: `pane-${name}`,
        root: {
          kind: "leaf",
          id: `pane-${name}`,
          activeTabId: tabId,
          tabs: [
            {
              id: tabId,
              type: "agent-native",
              nativeAgentData: { environmentId, platform, isLocal: true },
              ...(model ? { initialAgentModel: model } : {}),
            },
          ],
        },
      },
    });
    identity = {
      environmentId,
      agent: platform,
      logicalSessionKey: `env-${environmentId}:${tabId}`,
    };
    const id = identity;
    // The tab's `initialAgentModel` belongs to the launcher; pin the model here.
    await invoke("ensure_native_agent_session", { ...id, ...(model ? { model } : {}) });
    const projection = () =>
      invoke<Projection | null>("get_native_agent_projection", { ...id, messageLimit: 200 });
    // A queue nothing was ever added to reads as null.
    const promptQueue = async () =>
      (await invoke<{ messages: unknown[]; inFlight?: unknown } | null>("get_prompt_queue", {
        queueKey: `${platform}\0${id.logicalSessionKey}`,
      })) ?? { messages: [] };
    const tryDispatch = (prompt: string) =>
      invoke<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
        ...id,
        ...(platform === "claude" || platform === "codex" ? { mode: "build" } : {}),
        requestId: randomUUID(),
        prompt,
      });
    const dispatch = async (prompt: string) => {
      let requestId = "";
      // A fresh environment's first dispatch can be refused while its bridge
      // starts; a refused request never ran, so it goes again under a new id.
      const outcome = await dispatchProbeTurn(
        (next) =>
          invoke<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
            ...id,
            // Without a mode Claude and Codex would run in plan mode.
            ...(platform === "claude" || platform === "codex" ? { mode: "build" } : {}),
            requestId: (requestId = next),
            prompt,
          }),
        randomUUID,
        () => sleep(3_000),
      );
      expect(outcome.outcome, outcome.error).toBe("accepted");
      return requestId;
    };
    const settled = async (...markers: string[]) => {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let idleReads = 0;
      for (;;) {
        const current = await projection();
        const phase = current?.turn.phase ?? "idle";
        if (phase === "error") throw new Error(`turn error: ${current?.turn.error ?? "unknown"}`);
        const replied = markers.some(
          (marker) => rowsCarrying(current?.messages ?? [], "assistant", marker) > 0,
        );
        idleReads = phase === "idle" && replied ? idleReads + 1 : 0;
        if (idleReads >= 2) return current!;
        if (Date.now() > deadline) {
          // Fixture strings only: the last rows say what the model answered.
          const tail = (current?.messages ?? [])
            .slice(-6)
            .map((message) => `${message.role}: ${messageText(message).slice(0, 120)}`)
            .join(" | ");
          throw new Error(`no settled reply carrying ${markers.join(" or ")} (${phase}): ${tail}`);
        }
        await sleep(1_000);
      }
    };
    // Tool turns run unattended: the most permissive approval mode offered,
    // and Build where the platform has modes. Claude starts in bypass mode
    // already, which the stop case relies on.
    const initial = await projection();
    const modes = initial?.composer?.approvalModes ?? [];
    const auto =
      platform === "claude"
        ? undefined
        : (modes.find((mode) => mode.kind === "auto-approve") ??
          modes.find((mode) => mode.kind === "auto-review"));
    const hasBuild = (initial?.composer?.modes ?? []).some((mode) => mode.id === "build");
    const update = {
      ...(hasBuild ? { mode: "build" } : {}),
      ...(auto ? { approvalMode: auto.id } : {}),
    };
    if (Object.keys(update).length > 0) {
      await invoke("update_native_agent_controls", { ...id, update });
    }
    return {
      invoke,
      raw,
      identity: id,
      projection,
      promptQueue,
      dispatch,
      tryDispatch,
      settled,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Steer through the composer's route. A turn that has only just started can
 * read running before its bridge names the run; the backend then refuses
 * ("not ready to steer", nothing sent), so that one answer is retried.
 */
async function steer(harness: Harness, text: string): Promise<SteerOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await harness.invoke<SteerOutcome>("perform_native_agent_session_action", {
        ...harness.identity,
        action: { kind: "steer", text },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 10 || !/not ready to steer/.test(message)) throw error;
      await sleep(1_000);
    }
  }
}

test.describe("missed steer on the real bridges", () => {
  test.skip(
    !LIVE,
    "opt-in scripted-model turns on an isolated profile; set ORKESTRATOR_AGENT_TEST_LIVE_MISSED_STEER=1",
  );

  for (const platform of MISSED_STEER_PLATFORMS) {
    const label = MISSED_STEER_LABELS[platform];
    test(`${label}: a steer that misses its turn starts one new turn; a replaced turn takes the steer`, async ({
      page,
    }) => {
      test.skip(!SELECTED.has(platform), `${label} is not selected`);
      test.setTimeout(10 * 60_000);
      page.setDefaultTimeout(20_000);
      const evidence: Record<string, unknown> = { platform, startedAt: new Date().toISOString() };
      const harness = await openHarness(page, platform, "msteer");
      try {
        progress(`${label}: missed turn`);
        // 1. Missed turn: the first turn ends before the steer arrives.
        const first = word("FIRST");
        await harness.dispatch(replyPrompt(first));
        const afterFirst = await harness.settled(first);
        const controlsBefore = composerControls(afterFirst.composer);
        evidence.controls = controlsBefore;
        const missed = word("MISSED");
        const missedOutcome = await steer(harness, replyPrompt(missed));
        evidence.missedOutcome = {
          outcome: missedOutcome.outcome,
          deliveredAs: missedOutcome.deliveredAs ?? null,
        };
        expect(missedOutcome.outcome).toBe("applied");
        expect(missedOutcome.deliveredAs).toBe("new-turn");
        const afterMissed = await harness.settled(missed);
        // A reload reads the backend's snapshot again; it must agree.
        await sleep(2_000);
        const reread = (await harness.projection())!;
        const queue = await harness.promptQueue();
        const missedCounts = [afterMissed, reread].map((view) => ({
          userRows: rowsCarrying(view.messages, "user", missed),
          assistantRows: rowsCarrying(view.messages, "assistant", missed),
          queued: queue.messages.length,
          inFlight: queue.inFlight !== undefined || view.queue?.inFlightRequestId !== undefined,
          phase: view.turn.phase,
          controls: composerControls(view.composer),
        }));
        evidence.missed = missedCounts;
        for (const view of missedCounts) {
          expect(view).toEqual({
            userRows: 1,
            assistantRows: 1,
            queued: 0,
            inFlight: false,
            phase: "idle",
            controls: controlsBefore,
          });
        }
        if (platform === "cursor") {
          // The vendor's own record: one more run, carrying the steer's text.
          const turns = fakeCursorTurns(profileStatus().dataDir!, harness.identity.environmentId);
          evidence.cursorRuns = turns.map((turn) => turn.status);
          expect(turns.filter((turn) => turn.prompt.includes(missed))).toHaveLength(1);
          expect(steersCarrying(turns, missed)).toBe(0);
        }

        progress(`${label}: replaced turn`);
        // 2. Replaced turn: a second, long turn is running when the steer arrives.
        const long = word("LONG");
        await harness.dispatch(longTurnPrompt(platform, long, 25));
        await expect
          .poll(async () => (await harness.projection())?.turn.phase, { timeout: 60_000 })
          .toBe("running");
        const joined = word("JOINED");
        const joinedOutcome = await steer(harness, replyPrompt(joined));
        evidence.replacedOutcome = {
          outcome: joinedOutcome.outcome,
          deliveredAs: joinedOutcome.deliveredAs ?? null,
        };
        // Pi queues a steer in memory until the run's next model step, and
        // says `unknown` until it is delivered; the backend reconciles it.
        expect(platform === "pi" ? ["applied", "unknown"] : ["applied"]).toContain(
          joinedOutcome.outcome,
        );
        expect(joinedOutcome.deliveredAs).toBeUndefined();
        // Never queued as a turn of its own. (Pi lists a steer it has not yet
        // delivered in the projection's queue, from its own steering queue.)
        evidence.providerQueueDuringLong = (await harness.projection())?.queue?.items?.length ?? 0;
        expect((await harness.promptQueue()).messages).toHaveLength(0);
        if (platform === "cursor") {
          const dataDir = profileStatus().dataDir!;
          const turns = fakeCursorTurns(dataDir, harness.identity.environmentId);
          // Steered into the held run, not started as a run of its own.
          expect(steersCarrying(turns, joined)).toBe(1);
          expect(turns.filter((turn) => turn.prompt.includes(joined))).toHaveLength(0);
          await harness.invoke("stop_native_agent_session", harness.identity);
          await expect
            .poll(async () => (await harness.projection())?.turn.phase, { timeout: 60_000 })
            .toBe("idle");
        } else {
          // The steer joined this turn, so the scripted model may answer it
          // rather than the command it was running, or, when the CLI puts
          // the steer beside the command's result, give its default reply.
          await harness.settled(long, joined, SCRIPTED_DEFAULT_REPLY);
        }
        // A steer left `unknown` is reconciled from the bridge's journal.
        await expect
          .poll(async () => (await harness.projection())?.recoverableDispatch ?? null, {
            timeout: 60_000,
          })
          .toBeNull();
        await sleep(2_000);
        const afterLong = (await harness.projection())!;
        const replaced = {
          userRows: rowsCarrying(afterLong.messages, "user", joined),
          queued: (await harness.promptQueue()).messages.length,
          providerQueue: afterLong.queue?.items?.length ?? 0,
          phase: afterLong.turn.phase,
        };
        evidence.replaced = replaced;
        expect(replaced.userRows).toBeLessThanOrEqual(1);
        expect(replaced.queued).toBe(0);
        expect(replaced.providerQueue).toBe(0);
        expect(replaced.phase).toBe("idle");
        evidence.passed = true;
      } finally {
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(platform, evidence);
        await harness.cleanup();
      }
    });
  }

  test("Claude: stopping a background task after two follow-ups reaches it; after release it is refused", async ({
    page,
  }) => {
    test.skip(!SELECTED.has("claude"), "Claude is not selected");
    test.setTimeout(15 * 60_000);
    page.setDefaultTimeout(20_000);
    const evidence: Record<string, unknown> = {
      platform: "claude",
      startedAt: new Date().toISOString(),
    };
    const harness = await openHarness(page, "claude", "mstop");
    /**
     * The generation as the app shows it, past the backend's runtime-health
     * cache: a read after expiry answers from the cache and refreshes it, so
     * two agreeing reads after that are the answer.
     */
    const freshGeneration = async () => {
      progress("waiting out the runtime-health cache");
      await sleep(METADATA_TTL_MS + 2_000);
      await harness.projection();
      const deadline = Date.now() + 30_000;
      let last: number | undefined;
      for (;;) {
        await sleep(2_000);
        const current = await harness.projection();
        const generation =
          current?.runtimeHealthAuthoritative === false
            ? undefined
            : current?.runtime?.runtimeGeneration;
        if (generation !== undefined && generation === last) return generation;
        last = generation;
        if (Date.now() > deadline) return generation;
      }
    };
    try {
      const marker = word("BG");
      const started = word("STARTED");
      await harness.dispatch(backgroundTaskPrompt(marker, started, 900));
      await harness.settled(started);
      let taskId: string | undefined;
      await expect
        .poll(
          async () => {
            const tasks = (await harness.projection())?.backgroundTasks ?? [];
            taskId = tasks.find((task) => task.status === "running")?.id;
            return taskId !== undefined;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const generations: Record<string, number | undefined> = {};
      generations.afterStart = await freshGeneration();
      for (const step of ["F1", "F2"]) {
        const reply = word(step);
        await harness.dispatch(replyPrompt(reply));
        await harness.settled(reply);
        const tasks = (await harness.projection())?.backgroundTasks ?? [];
        expect(tasks.find((task) => task.id === taskId)?.status).toBe("running");
      }
      generations.afterFollowUps = await freshGeneration();
      expect(generations.afterStart).toBeDefined();
      expect(generations.afterFollowUps).toBe(generations.afterStart);

      progress("Claude: stopping the task");
      // The stop reaches the CLI that started the task two turns earlier.
      const stop = await harness.raw("stop_native_agent_background_task", {
        ...harness.identity,
        taskId,
      });
      evidence.stop = { ok: stop.ok };
      expect(stop.ok, stop.text.slice(0, 500)).toBe(true);
      let settledStatus: string | undefined;
      await expect
        .poll(
          async () => {
            const tasks = (await harness.projection())?.backgroundTasks ?? [];
            settledStatus = tasks.find((task) => task.id === taskId)?.status;
            return backgroundTaskSettled(settledStatus);
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      evidence.settledStatus = settledStatus;
      // The task's notification may start a short continuation; let it end.
      await expect
        .poll(async () => (await harness.projection())?.turn.phase, { timeout: 120_000 })
        .toBe("idle");

      // Whether the CLI asked the model to continue after the stop (the
      // scripted model answers a task notification "Noted.").
      await sleep(20_000);
      const afterStop = (await harness.projection())?.messages ?? [];
      evidence.continuationAfterStop = rowsCarrying(afterStop, "assistant", "Noted.");
      progress(
        `after the stop: ${evidence.continuationAfterStop} continuation replies; last rows ${afterStop
          .slice(-4)
          .map((message) => `${message.role}: ${messageText(message).slice(0, 80)}`)
          .join(" | ")}`,
      );
      progress("Claude: releasing the CLI");
      // Release the CLI: leaving bypass mode is launch-only, so the next turn
      // retires the idle CLI and runs on a new one.
      const modes = (await harness.projection())?.composer?.approvalModes ?? [];
      const asks =
        modes.find((mode) => mode.id === "default") ?? modes.find((mode) => mode.kind === "ask");
      expect(asks, "the composer offers an asking approval mode").toBeTruthy();
      await harness.invoke("update_native_agent_controls", {
        ...harness.identity,
        update: { approvalMode: asks!.id },
      });
      // The CLI queues the stopped task's notification for the next prompt
      // and starts no turn for it, so nothing is owed: the launch-only change
      // must be taken at once, not refused as "still running background work"
      // until the idle window ends (todo 0005 task 10, fixed 2026-11-14).
      const after = word("AFTER");
      const stoppedAt = Date.now();
      let refusals = 0;
      for (;;) {
        const outcome = await harness.tryDispatch(replyPrompt(after));
        if (outcome.outcome === "accepted") break;
        expect(outcome.error ?? "", "only the owed-work conflict is waited out").toContain(
          "still running background work",
        );
        refusals += 1;
        if (refusals % 6 === 1)
          progress(`release refused ${refusals}x, ${Date.now() - stoppedAt} ms after the stop`);
        if (Date.now() - stoppedAt > RELEASE_WAIT_MS) {
          throw new Error(`the CLI was not released ${RELEASE_WAIT_MS} ms after the stop`);
        }
        await sleep(5_000);
      }
      const continuationRows = rowsCarrying(
        (await harness.projection())?.messages ?? [],
        "assistant",
        "Noted.",
      );
      evidence.release = { waitedMs: Date.now() - stoppedAt, refusals, continuationRows };
      await harness.settled(after);
      generations.afterRelease = await freshGeneration();
      evidence.generations = generations;
      expect(generations.afterRelease).toBeGreaterThan(generations.afterFollowUps!);

      const refused = await harness.raw("stop_native_agent_background_task", {
        ...harness.identity,
        taskId,
      });
      evidence.stopAfterRelease = {
        ok: refused.ok,
        noControlChannel: isNoControlChannelRefusal(refused.text),
      };
      expect(refused.ok).toBe(false);
      expect(isNoControlChannelRefusal(refused.text), refused.text.slice(0, 500)).toBe(true);
      evidence.passed = true;
    } finally {
      evidence.finishedAt = new Date().toISOString();
      writeEvidence("claude-stop", evidence);
      await harness.cleanup();
    }
  });
});
