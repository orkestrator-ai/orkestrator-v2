/**
 * Live coordinator scenarios against a real `dev:test --fixture` profile, one
 * case per platform and scenario on the live suite's lists: `read-only` (the
 * boundary), `async` and `family` (real workers and their mail, see
 * `coordinator-live-delegation.ts`), `status` (a Multi Review's and a held
 * worker's status wakes, see `coordinator-live-status.ts`) and `peer`. Every
 * scenario with mail also judges each echoed carrier through the renderer's
 * tile parser (`coordinator-mail-tiles.ts`).
 *
 * Opt-in only: each case runs a real coordinator turn on the host's
 * credentials, so every case is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR=1`. Run it through
 * `mise run test:agent:coordinator`, which starts one disposable profile per
 * platform. Nothing at module scope spawns `mise` or reads profile state.
 *
 * Each case assigns the platform to a fresh main coordinator conversation on
 * the fixture project, through the same backend commands the Coordinator page
 * uses, so the real coordinator policy, bridge and Control MCP credential are
 * in play. The turn is sent in build mode (see the dispatch below). It digests
 * the checkout, asks the agent to attempt one mutation of
 * each class (file write, edit, writing shell command, commit, an Orkestrator
 * tool aimed at the checkout, a network fetch) and then to read a canary file
 * and a canary ticket, and asserts that the checkout is unchanged, that no
 * attempt is reported or seen to have succeeded or been skipped, that no
 * approval or question escaped the coordinator policy, that launch_job left
 * no job on the project home, and that both canary values came back. A
 * platform without a usable credential is skipped with the reason recorded,
 * never passed.
 *
 * Each case writes a content-free summary to
 * `output/agent-testing/<run>/coordinator/<platform>-<scenario>.json`, which
 * the runner aggregates. It never records prompts, message bodies, file
 * contents or tool output.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionKind,
} from "@orkestrator/protocol/agent-interactions";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentAuthState } from "@orkestrator/protocol/native-agent";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import {
  COORDINATOR_LIVE_OPT_IN_ENV,
  COORDINATOR_LIVE_PLATFORMS_ENV,
  COORDINATOR_LIVE_SCENARIOS_ENV,
  READ_ONLY_REPORT_MARKER,
  coordinatorLivePlatformsFromEnv,
  coordinatorLiveScenariosFromEnv,
  coordinatorLiveSummaryFile,
  createTurnWatch,
  describeDigestChanges,
  evaluateReadOnlyConversation,
  fixtureTreeDigest,
  homeEnvironmentWork,
  isSignInError,
  isSignedOut,
  parseReadOnlyReport,
  readOnlyScenarioPrompt,
  signedOutTurnReason,
  transcriptAssistantText,
  transcriptToolCalls,
  withCodeModeCellDetails,
  type CoordinatorLiveCheck,
  type CoordinatorLivePlatform,
  type CoordinatorLivePlatformSummary,
  type CoordinatorLiveScenario,
  type CoordinatorTranscriptMessage,
  type CoordinatorTurnProjection,
  type ReadOnlyProbe,
  type ToolDetails,
} from "../../apps/desktop/scripts/dev/coordinator-live";
import {
  asyncPollPrompt,
  asyncScenarioPrompt,
  asyncWorkerNames,
  carrierCount,
  coordinatorWaitCounts,
  delegationFailures,
  evaluateAsyncScenario,
  evaluateFamilyScenario,
  familyScenarioPrompt,
  familyWorkerNames,
  parseAsyncPollReport,
  transcriptUserTexts,
  type DelegationMailMessage,
  type DelegationProbe,
  type DelegationRecord,
} from "../../apps/desktop/scripts/dev/coordinator-live-delegation";
import { coordinatorLiveBudgets } from "../../apps/desktop/scripts/dev/coordinator-live-budgets";
import { runPeerScenario } from "../../apps/desktop/scripts/dev/coordinator-live-peer-orchestration";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  runCoordinatorCleanup,
} from "../../apps/desktop/scripts/dev/coordinator-live-observer";
import {
  STATUS_REVIEWEE_FILE,
  STATUS_REVIEW_DONE_MARKER,
  STATUS_WAITER_DONE_MARKER,
  STATUS_WAITING_MARKER,
  STATUS_WAITING_STATE,
  approvalWaitApplies,
  evaluateStatusReview,
  evaluateStatusWaiting,
  revieweeEnvironmentInput,
  statusReviewAgentSettings,
  statusReviewPrompt,
  statusWaitingPrompt,
  waiterEnvironmentInput,
  type StatusProbe,
} from "../../apps/desktop/scripts/dev/coordinator-live-status";
import { evaluateMailTiles } from "./coordinator-mail-tiles";
import {
  deliverAsyncReport,
  finishFamilyExchange,
} from "../../apps/desktop/scripts/dev/coordinator-live-orchestration";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Projection = CoordinatorTurnProjection;
type SessionIdentity = { environmentId: string; agent: AgentPlatform; logicalSessionKey: string };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env[COORDINATOR_LIVE_OPT_IN_ENV] === "1";
const budgets = coordinatorLiveBudgets();
const TURN_TIMEOUT_MS = budgets.turn;
const POLL_INTERVAL_MS = 2_000;
/**
 * A live turn prints nothing for minutes. `test:logged` kills a command after
 * five minutes without output, so the wait reports progress well inside that.
 */
const HEARTBEAT_MS = 60_000;
const CANARY_FILE = "coordinator-live-canary.txt";

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(
      `dev:status for profile "${profile}" returned no manifest: ${command.stderr.trim()}`,
    );
  }
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    const text = await result.text();
    if (!result.ok()) throw new Error(`${command}: ${text.slice(0, 500)}`);
    return (JSON.parse(text) as { result: T }).result;
  };
}

/** Ready agent-test profile, signed in, with its seeded fixture project. */
async function openProfile(page: Page) {
  const status = profileStatus();
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(
    status.status,
    `profile "${profile}" is not running; start it with mise run dev:test --fixture`,
  ).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  expect(status.dataDir).toBe(runtime.dataDir);
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
  return { checkout: status.testProject!, invoke, fixture: fixture! };
}

/**
 * Wait for the coordinator's turn to end, answering nothing on its behalf.
 *
 * See {@link createTurnWatch}: a pending approval or question has escaped the
 * coordinator policy. It is denied (or cancelled) here so the turn stays safe
 * and bounded, and recorded so the verdict fails.
 */
async function settleTurn(
  invoke: Invoke,
  identity: SessionIdentity,
  summary: CoordinatorLivePlatformSummary,
): Promise<{ projection: Projection; escaped: AgentInteractionKind[] }> {
  const started = Date.now();
  const deadline = started + TURN_TIMEOUT_MS;
  let nextHeartbeat = started + HEARTBEAT_MS;
  const watch = createTurnWatch();
  for (;;) {
    const projection = await invoke<Projection | null>("get_native_agent_projection", {
      ...identity,
      messageLimit: 200,
    });
    const { settled, answers } = watch.observe(projection);
    for (const answer of answers) {
      await invoke("resolve_native_agent_interaction", {
        ...identity,
        interactionId: answer.interactionId,
        resolution: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          ...answer,
          resolvedAt: Date.now(),
        },
      }).catch(() => undefined);
    }
    if (answers.length > 0) summary.escapedInteractions = watch.escapedInteractions();
    if (projection && settled) {
      return { projection, escaped: watch.escapedInteractions() };
    }
    const phase = projection?.turn.phase ?? "idle";
    const now = Date.now();
    if (now >= deadline) {
      throw new Error(
        `the ${identity.agent} coordinator turn did not finish within ${TURN_TIMEOUT_MS / 1_000}s (phase ${phase})`,
      );
    }
    if (now >= nextHeartbeat) {
      console.log(
        `[coordinator-live] ${identity.agent}: turn ${phase} for ${Math.round((now - started) / 1_000)}s, ${transcriptToolCalls(projection?.messages ?? []).length} tool calls so far`,
      );
      nextHeartbeat = now + HEARTBEAT_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function writeSummary(summary: CoordinatorLivePlatformSummary): Promise<void> {
  const file = coordinatorLiveSummaryFile(
    repositoryRoot,
    runId,
    summary.platform,
    summary.scenario ?? "read-only",
  );
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

/** What every case starts from: a signed-in, assigned, fresh main coordinator. */
interface CoordinatorCase {
  checkout: string;
  invoke: Invoke;
  projectId: string;
  conversation: CoordinatorConversation;
  identity: SessionIdentity;
}

/**
 * Assigns the platform to a fresh main conversation on the fixture project
 * through the Coordinator page's backend commands, or skips the case when the
 * profile has no usable login. Every setting it changes, and the conversation
 * it opens, is undone through `cleanup`.
 */
async function startCoordinatorCase(input: {
  page: Page;
  entry: CoordinatorLivePlatform;
  summary: CoordinatorLivePlatformSummary;
  settings: Record<string, unknown>;
  skip: (reason: string) => never;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<CoordinatorCase> {
  const { entry, summary, skip, cleanup } = input;
  const { platform } = entry;
  const { checkout, invoke, fixture } = await openProfile(input.page);
  const projectId = fixture.id;

  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const enabled = config.global.enabledAgentPlatforms;
  if (Array.isArray(enabled) && !enabled.includes(platform)) {
    skip(`${platform} is not enabled in this profile (start it with --agent-platforms)`);
  }
  const caseSettings = { coordinatorProviderTiers: entry.tierSetting, ...input.settings };
  const previousSettings = Object.fromEntries(
    Object.keys(caseSettings).map((key) => [key, config.global[key]]),
  );
  await invoke("update_global_config", { global: { ...config.global, ...caseSettings } });
  cleanup.push(async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", {
      global: { ...current.global, ...previousSettings },
    });
  });

  // A fresh, unassigned main conversation: a platform is bound by the
  // first prompt and never changes, so an earlier case's main is closed.
  let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", { projectId });
  const previous = coordinatorMainConversation(snapshot.workspace);
  if (previous?.agent) {
    snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
      projectId,
      conversationId: previous.id,
    });
  }
  if (!coordinatorMainConversation(snapshot.workspace)) {
    snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", { projectId });
  }
  const conversation = coordinatorMainConversation(snapshot.workspace)!;
  const qualification = snapshot.providerAvailability[platform];
  summary.tier = qualification?.tier;
  expect(
    qualification?.available,
    `${platform} is not offered to Coordinator: ${qualification?.reason ?? "no qualification"}`,
  ).toBe(true);
  expect(qualification?.delegation, `${platform} has no delegation`).toBe(true);
  expect(
    snapshot.controlMcp.running,
    `Control MCP is not running: ${snapshot.controlMcp.error ?? "disabled"}`,
  ).toBe(true);

  snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
    projectId,
    conversationId: conversation.id,
    agent: platform,
  });
  cleanup.push(() =>
    invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
  );
  const identity: SessionIdentity = {
    environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
    agent: platform,
    logicalSessionKey: conversation.logicalSessionKey,
  };
  try {
    await invoke("ensure_native_agent_session", identity);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isSignInError(message)) {
      skip(`no usable ${platform} credential in this profile: ${message.slice(0, 300)}`);
    }
    throw error;
  }
  const auth = await invoke<{ state: NativeAgentAuthState } | null>(
    "get_native_agent_auth_status",
    identity,
  ).catch(() => null);
  if (isSignedOut(auth?.state)) {
    skip(`no usable ${platform} credential in this profile (${auth!.state})`);
  }
  return { checkout, invoke, projectId, conversation, identity };
}

/** One case's summary, skip and cleanup, written whatever happens. */
async function runCase(
  entry: CoordinatorLivePlatform,
  scenario: CoordinatorLiveScenario,
  body: (context: {
    summary: CoordinatorLivePlatformSummary;
    skip: (reason: string) => never;
    cleanup: Array<() => Promise<unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: entry.platform,
    scenario,
    verdict: "failed",
    tierSetting: entry.tierSetting,
    startedAt: new Date().toISOString(),
  };
  const started = Date.now();
  const skip = (reason: string): never => {
    summary.verdict = "skipped";
    summary.reason = reason;
    test.skip(true, reason);
    throw new Error(reason);
  };
  // Undone last-first in `finally`, whatever happened before.
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    await body({ summary, skip, cleanup });
  } catch (error) {
    if (summary.verdict !== "skipped") {
      summary.verdict = "failed";
      summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    }
    throw error;
  } finally {
    await runCoordinatorCleanup(cleanup, summary);
    summary.durationMs = Date.now() - started;
    await writeSummary(summary);
  }
}

/**
 * The read-only scenario: digest the checkout, ask for one attempt per
 * mutation class, then require the checkout unchanged, every attempt refused
 * and both canaries read back.
 */
async function readOnlyCase(input: {
  checkout: string;
  invoke: Invoke;
  projectId: string;
  identity: SessionIdentity;
  platform: AgentPlatform;
  summary: CoordinatorLivePlatformSummary;
  skip: (reason: string) => never;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<void> {
  const { checkout, invoke, projectId, identity, platform, summary, skip, cleanup } = input;
  // Canaries reachable only through a working read tool and Control MCP.
  const canaryLine = `coordinator-live-canary-${randomBytes(8).toString("hex")}`;
  await writeFile(path.join(checkout, CANARY_FILE), `${canaryLine}\n`);
  cleanup.push(() => rm(path.join(checkout, CANARY_FILE), { force: true }));
  const ticketTitle = `coordinator-live-discovery-${randomBytes(8).toString("hex")}`;
  const ticket = await invoke<{ id: string }>("add_kanban_task", {
    projectId,
    title: ticketTitle,
    description: "Synthetic ticket read back by the live coordinator read-only scenario.",
  });
  cleanup.push(() => invoke("delete_kanban_task", { taskId: ticket.id }));
  // The project home is the checkout as an environment: the one target a
  // coordinator credential must never act on.
  const home = await invoke<{ id: string }>("ensure_project_home_environment", {
    projectId,
  });
  // The agent is told not to launch workers. One it launches anyway is
  // removed after the checkout has been measured, so it still counts.
  await removeLaunchedEnvironments(invoke, projectId, cleanup);

  const probe: ReadOnlyProbe = {
    platform,
    canaryFile: CANARY_FILE,
    canaryLine,
    ticketTitle,
    homeEnvironmentId: home.id,
    requestId: `coordinator-live-${randomUUID()}`,
  };
  // What a launched job leaves on the project home, read before the
  // digest so a worker that writes after the turn still counts.
  const homeWork = async () =>
    homeEnvironmentWork(
      await invoke<unknown>("get_pane_layout", { environmentId: home.id }),
      await invoke<unknown>("get_sessions_by_environment", { environmentId: home.id }),
    );
  const homeBefore = await homeWork();
  const before = await fixtureTreeDigest(checkout);
  summary.tree = { before: before.digest };
  // Build mode, not the plan mode a fresh coordinator composer selects:
  // plan mode asks the agent not to try, so the boundary would never be
  // exercised. Build mode is where a coordinator lands after its plan is
  // approved, and the policy has to hold there whatever the agent tries.
  await invoke("dispatch_native_agent_intent", {
    ...identity,
    prompt: readOnlyScenarioPrompt(probe),
    requestId: randomUUID(),
    mode: "build",
  });
  const { projection: settled, escaped } = await settleTurn(invoke, identity, summary);
  const homeAfter = await homeWork();
  const after = await fixtureTreeDigest(checkout);
  summary.tree = {
    before: before.digest,
    after: after.digest,
    changes: describeDigestChanges(before, after),
  };
  summary.turn = {
    phase: settled.turn.phase,
    ...(settled.turn.error ? { error: settled.turn.error.slice(0, 500) } : {}),
  };

  const report = parseReadOnlyReport(transcriptAssistantText(settled.messages));
  if (!("error" in report)) summary.outcomes = report.outcomes;
  // Codex's refused calls show as the code-mode cells that made them,
  // whose output (the evidence) is fetched as opening the row does.
  const messages =
    platform === "codex"
      ? await withCodeModeCellDetails(settled.messages, (detailRef) =>
          invoke<ToolDetails | null>("get_native_agent_tool_details", {
            ...identity,
            detailRef,
          }),
        )
      : settled.messages;
  const { failures, toolCalls, cellRows, cellCalls } = evaluateReadOnlyConversation({
    platform,
    messages,
    before,
    after,
    report,
    probe,
    escapedInteractions: escaped,
    homeWork: { before: homeBefore, after: homeAfter },
  });
  summary.toolCalls = toolCalls.map(({ name, state }) => ({ name, state }));
  if (platform === "codex") summary.cellCalls = { rows: cellRows, counted: cellCalls };
  if (settled.turn.phase === "error") {
    const signedOut = signedOutTurnReason({
      projection: settled,
      reported: !("error" in report),
      checkoutChanged: (summary.tree.changes?.length ?? 0) > 0 || escaped.length > 0,
    });
    if (signedOut) skip(`no usable ${platform} credential in this profile (${signedOut})`);
    failures.unshift(`the turn failed: ${settled.turn.error ?? "no error text"}`);
  }
  summary.verdict = failures.length === 0 ? "passed" : "failed";
  if (failures.length > 0) summary.reason = failures.join("; ");
  expect(
    failures,
    `${platform}: the read-only scenario must leave the checkout unchanged, refuse every mutation and still read (${READ_ONLY_REPORT_MARKER} outcomes: ${JSON.stringify(summary.outcomes ?? {})})`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Delegation scenarios: the harness watches, and answers nothing

function recordChecks(
  summary: CoordinatorLivePlatformSummary,
  checks: CoordinatorLiveCheck[],
  observed: Record<string, number>,
): string[] {
  summary.checks = checks;
  summary.observed = observed;
  const failures = delegationFailures(checks);
  summary.verdict = failures.length === 0 ? "passed" : "failed";
  if (failures.length > 0) summary.reason = failures.join("; ");
  return failures;
}

/**
 * Dispatch one coordinator turn in build mode and wait for it to end: idle
 * for two reads after it was seen working or added a row, with nothing left
 * in its prompt queue.
 */
async function coordinatorTurn(
  watch: ReturnType<typeof createDelegationWatch>,
  coordinator: CoordinatorCase,
  label: string,
  prompt: string,
): Promise<{ phases: string[]; rowsBefore: number; endedAt: number }> {
  const before = await watch.observe();
  const rowsBefore = watch.projection()?.messages.length ?? 0;
  await coordinator.invoke("dispatch_native_agent_intent", {
    ...coordinator.identity,
    prompt,
    requestId: randomUUID(),
    mode: "build",
  });
  const phases = [before.coordinatorPhase];
  let sawActive = false;
  let idleReads = 0;
  const end = await watch.until(label, (observation) => {
    phases.push(observation.coordinatorPhase);
    if (observation.coordinatorPhase === "error") {
      throw new Error(
        `the ${coordinator.identity.agent} coordinator turn failed: ${watch.projection()?.turn.error ?? "no error text"}`,
      );
    }
    if (observation.coordinatorPhase !== "idle") sawActive = true;
    idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
    const grew = (watch.projection()?.messages.length ?? 0) > rowsBefore;
    return idleReads >= 2 && (sawActive || grew) && observation.queueLength === 0;
  });
  return { phases, rowsBefore, endedAt: end.at };
}

function mailCountsObserved(
  mail: readonly DelegationMailMessage[],
  coordinatorEnvironmentId: string,
  messages: readonly CoordinatorTranscriptMessage[],
): Record<string, number> {
  const toCoordinator = mail.filter(
    (message) => message.toEnvironmentId === coordinatorEnvironmentId,
  );
  return {
    messagesToCoordinator: toCoordinator.length,
    noticesToCoordinator: toCoordinator.filter((message) => message.from.kind === "system").length,
    // -1 records an unverified count; nearby timestamps cannot prove batching.
    coordinatorCarriers: carrierCount(toCoordinator, transcriptUserTexts(messages)) ?? -1,
    ...coordinatorWaitCounts(transcriptToolCalls(messages)),
  };
}

/** The coordinator transcript's mail tiles, judged against what was injected into it. */
function coordinatorTiles(
  mail: readonly DelegationMailMessage[],
  coordinatorEnvironmentId: string,
  messages: readonly CoordinatorTranscriptMessage[],
  requireBatched: boolean,
) {
  return evaluateMailTiles({
    messages,
    delivered: mail.filter(
      (message) =>
        message.toEnvironmentId === coordinatorEnvironmentId && message.placement === "injected",
    ),
    requireBatched,
  });
}

function tileCounts(observed: ReturnType<typeof evaluateMailTiles>["observed"]) {
  return {
    carrierRows: observed.carrierRows,
    tileRows: observed.tileRows,
    batchedTileRows: observed.batchedRows,
    tiles: observed.tiles,
  };
}

/**
 * The async scenario. The coordinator launches a reporter and a silent
 * worker and ends its turn. The silent worker finishes without mail. The
 * reporter sends one progress message and then waits for a gate file. Once
 * the silent worker's notice has been handled and the progress message is
 * seen held, the harness gives the coordinator a busy turn, queues a prompt
 * behind it and opens the gate, so the reporter's report is pending while the
 * coordinator is busy and a user prompt is queued. Last, a poll turn reads
 * the mailbox five times with identical arguments.
 */
async function asyncCase(input: {
  coordinator: CoordinatorCase;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<void> {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const gateDirectory = await mkdtemp(path.join(tmpdir(), "coordinator-live-gate-"));
  cleanup.push(() => rm(gateDirectory, { recursive: true, force: true }));
  const probe: DelegationProbe = {
    platform,
    token: randomBytes(6).toString("hex"),
    gatePath: path.join(gateDirectory, "report.go"),
    finishGatePath: path.join(gateDirectory, "finish.go"),
  };
  const names = asyncWorkerNames(probe);
  const watch = createDelegationWatch(invoke, coordinator, summary);
  const coordinatorEnvironmentId = identity.environmentId;
  const worker = (name: string) => watch.workers.find((id) => watch.workerName(id) === name);
  const fromReporter = (message: DelegationMailMessage) =>
    message.toEnvironmentId === coordinatorEnvironmentId &&
    message.from.kind === "tab" &&
    message.from.environmentId === worker(names.reporter);

  // 1–2. The delegating turn.
  const delegating = await coordinatorTurn(
    watch,
    coordinator,
    "the delegating turn",
    asyncScenarioPrompt(probe),
  );
  const delegatingMessages = (watch.projection()?.messages ?? []).slice(delegating.rowsBefore);
  const delegatingTurnCalls = transcriptToolCalls(delegatingMessages);
  const launchResults = await watch.toolOutputs("launch_environment", delegatingMessages);
  // The workers' names may land a read after the launch.
  await watch
    .until("the launched workers", () => Boolean(worker(names.reporter) && worker(names.silent)))
    .catch(() => undefined);
  const reporter = worker(names.reporter);
  const silent = worker(names.silent);

  let queuedAccepted = false;
  let pollResults: string[] = [];
  let pollCalls: ReturnType<typeof transcriptToolCalls> = [];
  let pollReport: ReturnType<typeof parseAsyncPollReport> | undefined;
  if (reporter && silent) {
    // 5. The silent worker's notice is handled, and the progress message is held.
    let idleReads = 0;
    await watch.until(
      "the silent worker's notice and the reporter's held progress",
      (observation) => {
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const silentWoken = observation.delegations.some(
          (delegation) => delegation.environmentId === silent && delegation.wokenAt !== undefined,
        );
        const progressHeld = observation.mail.some(
          (message) => fromReporter(message) && message.placement === "inject-held",
        );
        return silentWoken && progressHeld && idleReads >= 2 && observation.queueLength === 0;
      },
    );

    queuedAccepted = await deliverAsyncReport({ coordinator, watch, probe, fromReporter });

    // 6. The poll turn.
    const poll = await coordinatorTurn(
      watch,
      coordinator,
      "the poll turn",
      asyncPollPrompt(watch.coordinatorMailbox),
    );
    const pollMessages = (watch.projection()?.messages ?? []).slice(poll.rowsBefore);
    pollCalls = transcriptToolCalls(pollMessages);
    pollResults = await watch.toolOutputs("read_messages", pollMessages);
    pollReport = parseAsyncPollReport(transcriptAssistantText(pollMessages));
  }

  const projection = watch.projection();
  const messages = projection?.messages ?? [];
  const mail = await watch.mailWithBodies();
  const snapshot = await invoke<CoordinatorSnapshot>("get_project_coordinator", { projectId });
  const delegations: DelegationRecord[] = snapshot.workflows.flatMap((workflow) =>
    workflow.kind === "environment" &&
    workflow.conversationId === coordinator.conversation.id &&
    workflow.delegation
      ? [{ environmentId: workflow.resourceId, ...workflow.delegation }]
      : [],
  );
  const checks = evaluateAsyncScenario({
    probe,
    coordinatorEnvironmentId,
    workers: {
      ...(reporter ? { reporter: { role: "reporter", environmentId: reporter } } : {}),
      ...(silent ? { silent: { role: "silent", environmentId: silent } } : {}),
    },
    delegatingTurnPhases: delegating.phases,
    delegatingTurnEndedAt: delegating.endedAt,
    delegatingTurnCalls,
    launchResults,
    queuedAccepted,
    messages,
    mail,
    observations: watch.observations,
    delegations,
    pollResults,
    pollCalls,
    ...(pollReport ? { pollReport } : {}),
    escapedInteractions: watch.escaped(),
    workerInteractions: watch.workerEscaped(),
  });
  const tiles = coordinatorTiles(mail, coordinatorEnvironmentId, messages, true);
  const calls = transcriptToolCalls(messages);
  summary.toolCalls = calls.map(({ name, state }) => ({ name, state }));
  summary.turn = { phase: projection?.turn.phase ?? "idle" };
  const failures = recordChecks(summary, [...checks, ...tiles.checks], {
    ...mailCountsObserved(mail, coordinatorEnvironmentId, messages),
    ...tileCounts(tiles.observed),
    workers: watch.workers.length,
    observations: watch.observations.length,
  });
  expect(failures, `${platform}: the async delegation scenario`).toEqual([]);
}

/**
 * The family scenario: one prompt, then nobody touches anything. The
 * coordinator launches two workers and immediately follows the second up
 * while it is still on its first request; both report; the coordinator then
 * pings the first worker by environment id and they alternate until six pings
 * have been answered.
 */
async function familyCase(input: {
  coordinator: CoordinatorCase;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<void> {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const gateDirectory = await mkdtemp(path.join(tmpdir(), "coordinator-live-gate-"));
  cleanup.push(() => rm(gateDirectory, { recursive: true, force: true }));
  const probe: DelegationProbe = {
    platform,
    token: randomBytes(6).toString("hex"),
    gatePath: path.join(gateDirectory, "report.go"),
    finishGatePath: path.join(gateDirectory, "unused.go"),
  };
  const names = familyWorkerNames(probe);
  const watch = createDelegationWatch(invoke, coordinator, summary);
  const coordinatorEnvironmentId = identity.environmentId;

  // The scenario is defined against the shipped defaults; a profile that
  // changed them would prove something else.
  const messaging = await invoke<Record<string, unknown>>("get_agent_messaging_settings");
  const changedDefaults = Object.entries(DEFAULT_AGENT_MESSAGING_SETTINGS)
    .filter(([key, value]) => messaging[key] !== value)
    .map(([key]) => key);

  let finished: string | undefined;
  try {
    await coordinatorTurn(watch, coordinator, "the delegating turn", familyScenarioPrompt(probe));
    await finishFamilyExchange(watch, probe, names.two);
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }

  const projection = watch.projection();
  const messages = projection?.messages ?? [];
  const calls = transcriptToolCalls(messages);
  const mail = await watch.mailWithBodies();
  const worker = (name: string) => watch.workers.find((id) => watch.workerName(id) === name);
  const one = worker(names.one);
  const two = worker(names.two);
  const checks: CoordinatorLiveCheck[] = [
    {
      name: "default-messaging-settings",
      passed: changedDefaults.length === 0,
      ...(changedDefaults.length > 0 ? { detail: `changed: ${changedDefaults.join(", ")}` } : {}),
    },
    {
      name: "finished",
      passed: finished === undefined,
      ...(finished ? { detail: finished } : {}),
    },
    ...evaluateFamilyScenario({
      probe,
      coordinatorEnvironmentId,
      workers: {
        ...(one ? { one: { role: "one", environmentId: one } } : {}),
        ...(two ? { two: { role: "two", environmentId: two } } : {}),
      },
      calls,
      assistantText: transcriptAssistantText(messages),
      userTexts: transcriptUserTexts(messages),
      mail,
      observations: watch.observations,
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
      harnessPrompts: 1,
    }),
  ];
  const tiles = coordinatorTiles(mail, coordinatorEnvironmentId, messages, false);
  summary.toolCalls = calls.map(({ name, state }) => ({ name, state }));
  summary.turn = { phase: projection?.turn.phase ?? "idle" };
  const failures = recordChecks(summary, [...checks, ...tiles.checks], {
    ...mailCountsObserved(mail, coordinatorEnvironmentId, messages),
    ...tileCounts(tiles.observed),
    workers: watch.workers.length,
    observations: watch.observations.length,
  });
  expect(failures, `${platform}: the worker-mail family scenario`).toEqual([]);
}

/**
 * Waits for one of `identity`'s turns to settle (see {@link settleTurn}) and
 * fails on a turn error: an ordinary environment's startup turn here.
 */
async function startupTurn(
  invoke: Invoke,
  identity: SessionIdentity,
  summary: CoordinatorLivePlatformSummary,
  label: string,
): Promise<void> {
  const { projection } = await settleTurn(invoke, identity, summary);
  if (projection.turn.phase === "error") {
    throw new Error(`${label} failed: ${projection.turn.error ?? "no error text"}`);
  }
}

/** Whether the coordinator's assistant text after `fromRow` carries `line`. */
function saidAfter(
  watch: ReturnType<typeof createDelegationWatch>,
  fromRow: number,
  line: string,
): boolean {
  return transcriptAssistantText((watch.projection()?.messages ?? []).slice(fromRow)).includes(
    line,
  );
}

/**
 * The status scenario, in two parts on one coordinator. Review: it launches a
 * Multi Review on an environment the harness prepared, is woken when the
 * review is ready, addresses it, and is woken when the Fix turn finishes.
 * Approval (not on Cursor, which never asks): it delegates a task to an
 * environment whose policy asks for approvals; the harness holds the
 * worker's approval until the coordinator has been woken by the `waiting`
 * notice, then denies it and waits for the worker's report.
 */
async function statusCase(input: {
  coordinator: CoordinatorCase;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<void> {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  const coordinatorEnvironmentId = identity.environmentId;
  // Removes the two environments made here too: neither existed before.
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const token = randomBytes(6).toString("hex");

  // Saved Multi Review defaults on this platform, as the button would use.
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previousAgentSettings = config.global.agentSettings;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      agentSettings: statusReviewAgentSettings(previousAgentSettings, platform),
    },
  });
  cleanup.push(async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", {
      global: { ...current.global, agentSettings: previousAgentSettings },
    });
  });

  // The environment under review: a change with one real defect.
  const reviewee = await invoke<{ id: string }>(
    "create_environment",
    revieweeEnvironmentInput({ projectId, token }),
  );
  await invoke("start_environment", { environmentId: reviewee.id });
  const revieweeWorktree = (
    await invoke<{ worktreePath?: string | null }>("get_environment", {
      environmentId: reviewee.id,
    })
  ).worktreePath;
  expect(revieweeWorktree, "the reviewed environment has no worktree").toBeTruthy();
  await writeFile(
    path.join(revieweeWorktree!, STATUS_REVIEWEE_FILE.path),
    STATUS_REVIEWEE_FILE.content,
  );

  // The worker held on an approval: started and idle before it is delegated to.
  const holdsApproval = approvalWaitApplies(platform);
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "coordinator-live-status-"));
  cleanup.push(() => rm(outsideDirectory, { recursive: true, force: true }));
  let waiterEnvironmentId = "";
  if (holdsApproval) {
    const waiter = await invoke<{ id: string }>(
      "create_environment",
      waiterEnvironmentInput({ projectId, token, platform }),
    );
    await invoke("start_environment", { environmentId: waiter.id });
    waiterEnvironmentId = waiter.id;
    await startupTurn(
      invoke,
      {
        environmentId: waiter.id,
        agent: platform,
        logicalSessionKey: `env-${waiter.id}:startup-agent`,
      },
      summary,
      "the waiting worker's startup turn",
    );
  }
  const probe: StatusProbe = {
    platform,
    token,
    revieweeEnvironmentId: reviewee.id,
    waiterEnvironmentId,
    waiterTabId: "startup-agent",
    outsidePath: path.join(outsideDirectory, "approval-probe.txt"),
  };
  const watch = createDelegationWatch(invoke, coordinator, summary, undefined, {
    holdWorkerInteractions: (environmentId) => environmentId === waiterEnvironmentId,
  });
  const toCoordinator = (message: DelegationMailMessage) =>
    message.toEnvironmentId === coordinatorEnvironmentId && message.from.kind === "system";
  const failOnCoordinatorError = (phase: string) => {
    if (phase === "error") {
      throw new Error(
        `the ${platform} coordinator turn failed: ${watch.projection()?.turn.error ?? "no error text"}`,
      );
    }
  };

  // Review part.
  let reviewFinished: string | undefined;
  let reviewRowsBefore = watch.projection()?.messages.length ?? 0;
  try {
    reviewRowsBefore = (
      await coordinatorTurn(watch, coordinator, "the review launch turn", statusReviewPrompt(probe))
    ).rowsBefore;
    let idleReads = 0;
    await watch.until(
      "the Multi Review's fix-done wake",
      (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        const notices = observation.mail.filter(
          (message) =>
            toCoordinator(message) &&
            message.notice?.resource?.kind === "multi-review" &&
            message.notice.resource.environmentId === reviewee.id,
        );
        const ended = notices.find((message) =>
          ["failed", "cancelled", "fix-failed"].includes(message.notice?.state ?? ""),
        );
        if (ended) throw new Error(`the Multi Review reported ${ended.notice?.state}`);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const fixDone = notices.some(
          (message) => message.notice?.state === "fix-done" && message.placement === "injected",
        );
        return (
          fixDone &&
          saidAfter(watch, reviewRowsBefore, `${STATUS_REVIEW_DONE_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      },
      budgets.review,
    );
  } catch (error) {
    reviewFinished = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }
  const reviewMessages = (watch.projection()?.messages ?? []).slice(reviewRowsBefore);
  const reviewLaunches = await watch.toolOutputs("launch_multi_review", reviewMessages);
  const reviewEscaped = watch.escaped();
  const checks: CoordinatorLiveCheck[] = [
    {
      name: "review-finished",
      passed: reviewFinished === undefined,
      ...(reviewFinished ? { detail: reviewFinished } : {}),
    },
    ...evaluateStatusReview({
      probe,
      coordinatorEnvironmentId,
      messages: reviewMessages,
      launchResults: reviewLaunches,
      mail: watch.observations.at(-1)?.mail ?? [],
      escapedInteractions: reviewEscaped,
    }),
  ];

  // Approval part.
  if (holdsApproval) {
    let waitingFinished: string | undefined;
    let waitingRowsBefore = watch.projection()?.messages.length ?? 0;
    try {
      waitingRowsBefore = (
        await coordinatorTurn(
          watch,
          coordinator,
          "the approval delegation turn",
          statusWaitingPrompt(probe),
        )
      ).rowsBefore;
      await watch.until(
        "the worker's approval to reach the harness",
        () => watch.held(waiterEnvironmentId).length > 0,
      );
      let idleReads = 0;
      await watch.until("the waiting wake", (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const waiting = observation.mail.some(
          (message) =>
            toCoordinator(message) &&
            message.notice?.resource?.environmentId === waiterEnvironmentId &&
            message.notice.state === STATUS_WAITING_STATE &&
            message.placement === "injected",
        );
        return (
          waiting &&
          saidAfter(watch, waitingRowsBefore, `${STATUS_WAITING_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      });
      await watch.release(waiterEnvironmentId);
      idleReads = 0;
      await watch.until("the waiting worker's report", (observation) => {
        failOnCoordinatorError(observation.coordinatorPhase);
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        return (
          saidAfter(watch, waitingRowsBefore, `${STATUS_WAITER_DONE_MARKER} ${token}`) &&
          idleReads >= 2 &&
          observation.queueLength === 0
        );
      });
    } catch (error) {
      waitingFinished = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await watch.release(waiterEnvironmentId).catch(() => undefined);
    }
    checks.push(
      {
        name: "waiting-finished",
        passed: waitingFinished === undefined,
        ...(waitingFinished ? { detail: waitingFinished } : {}),
      },
      ...evaluateStatusWaiting({
        probe,
        coordinatorEnvironmentId,
        messages: (watch.projection()?.messages ?? []).slice(waitingRowsBefore),
        mail: watch.observations.at(-1)?.mail ?? [],
        held: watch.held(waiterEnvironmentId),
        escapedInteractions: watch.escaped().slice(reviewEscaped.length),
        workerInteractions: watch.workerEscaped(),
      }),
    );
  }

  const projection = watch.projection();
  const messages = projection?.messages ?? [];
  const mail = await watch.mailWithBodies();
  const tiles = coordinatorTiles(mail, coordinatorEnvironmentId, messages, false);
  const calls = transcriptToolCalls(messages);
  summary.toolCalls = calls.map(({ name, state }) => ({ name, state }));
  summary.turn = { phase: projection?.turn.phase ?? "idle" };
  const failures = recordChecks(summary, [...checks, ...tiles.checks], {
    ...mailCountsObserved(mail, coordinatorEnvironmentId, messages),
    ...tileCounts(tiles.observed),
    approvalWaitApplies: holdsApproval ? 1 : 0,
    heldInteractions: holdsApproval ? watch.held(waiterEnvironmentId).length : 0,
    observations: watch.observations.length,
  });
  expect(failures, `${platform}: the status-wake scenario`).toEqual([]);
}

/**
 * The peer scenario: two ordinary environments, neither launched by a
 * coordinator, with Wake peers on. The responder starts idle; the opener
 * sends it the first message by environment id; they alternate until ten
 * messages have moved. The harness sends nothing after the two startup
 * prompts and answers nothing.
 */
async function peerCase(input: {
  page: Page;
  entry: CoordinatorLivePlatform;
  summary: CoordinatorLivePlatformSummary;
  skip: (reason: string) => never;
  cleanup: Array<() => Promise<unknown>>;
}): Promise<void> {
  const { entry, summary, skip, cleanup } = input;
  const { platform } = entry;
  const { invoke, fixture } = await openProfile(input.page);
  const { checks, transcripts, escaped, mail, observations } = await runPeerScenario({
    invoke,
    projectId: fixture.id,
    probe: { platform, token: randomBytes(6).toString("hex") },
    skip,
    cleanup,
    log: (line) => console.log(line),
  });
  const calls = Object.values(transcripts).flatMap((messages) => transcriptToolCalls(messages));
  summary.toolCalls = calls.map(({ name, state }) => ({ name, state }));
  if (escaped.length > 0) summary.escapedInteractions = escaped;
  // Each peer's own transcript shows the mail it received.
  const tiles = Object.entries(transcripts).map(([environmentId, messages], index) =>
    evaluateMailTiles({
      messages,
      delivered: mail.filter(
        (message) => message.toEnvironmentId === environmentId && message.placement === "injected",
      ),
      prefix: `peer-${index + 1}-tiles`,
    }),
  );
  const failures = recordChecks(summary, [...checks, ...tiles.flatMap((item) => item.checks)], {
    peerMessages: mail.filter((message) => message.route === "peer").length,
    ...coordinatorWaitCounts(calls),
    ...tileCounts(
      tiles.reduce(
        (total, item) => ({
          carrierRows: total.carrierRows + item.observed.carrierRows,
          tileRows: total.tileRows + item.observed.tileRows,
          batchedRows: total.batchedRows + item.observed.batchedRows,
          tiles: total.tiles + item.observed.tiles,
        }),
        { carrierRows: 0, tileRows: 0, batchedRows: 0, tiles: 0 },
      ),
    ),
    observations: observations.length,
  });
  expect(failures, `${platform}: the peer-mail scenario`).toEqual([]);
}

test.describe("live coordinator", () => {
  test.skip(
    !LIVE,
    `opt-in: ${COORDINATOR_LIVE_OPT_IN_ENV}=1 runs real coordinator turns on host credentials; use mise run test:agent:coordinator`,
  );

  const scenarios = coordinatorLiveScenariosFromEnv(process.env[COORDINATOR_LIVE_SCENARIOS_ENV]);
  for (const entry of coordinatorLivePlatformsFromEnv(
    process.env[COORDINATOR_LIVE_PLATFORMS_ENV],
  )) {
    const { platform } = entry;
    if (scenarios.includes("read-only")) {
      test(`read-only boundary holds on ${platform}: every mutation is refused, the checkout is unchanged and discovery returns`, async ({
        page,
      }) => {
        test.setTimeout(budgets.tests["read-only"]);
        page.setDefaultTimeout(30_000);
        await runCase(entry, "read-only", async ({ summary, skip, cleanup }) => {
          // The network step tests the coordinator's whole `network` denial, so
          // the research exception (hosted search, on by default) is switched
          // off. What search may reach with it on is checked by the gated canary
          // in `bridges/codex-bridge/src/app-server/live-network-lock.test.ts`.
          const { checkout, invoke, projectId, identity } = await startCoordinatorCase({
            page,
            entry,
            summary,
            settings: { coordinatorWebResearch: "off" },
            skip,
            cleanup,
          });
          await readOnlyCase({
            checkout,
            invoke,
            projectId,
            identity,
            platform,
            summary,
            skip,
            cleanup,
          });
        });
      });
    }

    if (scenarios.includes("async")) {
      test(`delegation on ${platform} is asynchronous: async launch, queued prompt before mail, one carrier, one silent-worker notice, repeated reads refused`, async ({
        page,
      }) => {
        test.setTimeout(budgets.tests.async);
        page.setDefaultTimeout(30_000);
        await runCase(entry, "async", async ({ summary, skip, cleanup }) => {
          const coordinator = await startCoordinatorCase({
            page,
            entry,
            summary,
            settings: {},
            skip,
            cleanup,
          });
          await asyncCase({ coordinator, summary, cleanup });
        });
      });
    }

    if (scenarios.includes("family")) {
      test(`worker mail on ${platform} needs nobody: two reports, a follow-up by environment id, ten more alternating messages and a busy follow-up joining its delegation`, async ({
        page,
      }) => {
        test.setTimeout(budgets.tests.family);
        page.setDefaultTimeout(30_000);
        await runCase(entry, "family", async ({ summary, skip, cleanup }) => {
          const coordinator = await startCoordinatorCase({
            page,
            entry,
            summary,
            settings: {},
            skip,
            cleanup,
          });
          await familyCase({ coordinator, summary, cleanup });
        });
      });
    }

    if (scenarios.includes("status")) {
      test(`status wakes on ${platform}: a coordinator-launched Multi Review wakes it when ready and when its fix finishes, and a delegated worker held on an approval wakes it once`, async ({
        page,
      }) => {
        test.setTimeout(budgets.tests.status);
        page.setDefaultTimeout(30_000);
        await runCase(entry, "status", async ({ summary, skip, cleanup }) => {
          const coordinator = await startCoordinatorCase({
            page,
            entry,
            summary,
            settings: {},
            skip,
            cleanup,
          });
          await statusCase({ coordinator, summary, cleanup });
        });
      });
    }

    if (scenarios.includes("peer")) {
      test(`peer mail on ${platform} wakes both sides: ten alternating messages between two ordinary environments with Wake peers on and nobody acting`, async ({
        page,
      }) => {
        test.setTimeout(budgets.tests.peer);
        page.setDefaultTimeout(30_000);
        await runCase(entry, "peer", async ({ summary, skip, cleanup }) => {
          await peerCase({ page, entry, summary, skip, cleanup });
        });
      });
    }
  }
});
