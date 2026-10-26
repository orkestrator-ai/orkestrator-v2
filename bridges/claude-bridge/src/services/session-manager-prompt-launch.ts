import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { eventEmitter } from "./event-emitter.js";
import { debugLog } from "./logger.js";
import { AGENT_MCP_SERVER_NAME } from "./mcp-config.js";
import {
  closeQueryControl,
  emitBackgroundTaskSnapshot,
  forgetSettlingBackgroundTasksOwnedBy,
  removeBackgroundTaskCandidatesOwnedBy,
  settleTasksOwnedByClosedControl,
} from "./session-manager-background-tasks.js";
import { readLiveCommandInventory } from "./session-manager-commands.js";
import {
  createStructuredUsageRefreshCoordinator,
  sessionOperationError,
  sessions,
} from "./session-manager-core.js";
import { holdSdkPromptOpen, sdkPromptMessages } from "./session-manager-persistence.js";
import { createClaudeRuntimeMcp, syncClaudeRuntimeMcp } from "./session-manager-prompt-mcp-sync.js";
import {
  claudeQueryOptions,
  type QueryPlan,
  recordMcpConfigRevision,
} from "./session-manager-prompt-query.js";
import { createClaudeRuntimeTurn } from "./session-manager-prompt-runtime-turn.js";
import {
  claudeProcessKilledMessage,
  killedClaudeProcessSignal,
  syncTurnInFlightMark,
} from "./session-manager-turn-interruption.js";
import type { PromptTestHooks, TurnState } from "./session-manager-prompt-turn.js";
import {
  disarmClaudeRuntimeIdleDetach,
  noteClaudeRuntimeFrame,
} from "./session-manager-runtime-idle.js";
import {
  applyClaudeLiveSettings,
  assertClaudeRuntimeAccepts,
  claudeLaunchConflict,
  claudeLaunchedProfile,
  claudeLaunchProfile,
  claudeLaunchResourceProfile,
  claudeRuntimeOwesWork,
  type ClaudeRuntime,
  type ClaudeRuntimeTurn,
  createClaudeRuntime,
  openClaudeRuntime,
  retireDrainingClaudeRuntime,
  routeClaudeFrame,
  submitClaudeTurn,
} from "./session-manager-runtime.js";
import { reportUltracodeRuntime } from "./ultracode.js";

// Running a turn on the session's one CLI: writing it into the process that
// is still running, or launching a new one, and the consumer of its frames.
// Each step ends at an await the turn always made, and everything from the
// submit to `markQueryStarted` stays synchronous, so no frame is handled
// before the turn is ready for it.

/**
 * The single consumer of a runtime's frames, for the life of its process.
 *
 * Each frame goes to the turn it belongs to (`routeClaudeFrame`). A turn whose
 * handler throws ends the process — leaving the loop is the SDK's
 * `transport.close()` — and that turn's `sendPrompt` reports the error.
 */
async function consumeClaudeRuntime(
  runtime: ClaudeRuntime,
  frames: AsyncIterable<SDKMessage>,
  markEnded: () => void,
): Promise<void> {
  let failure: { turn: ClaudeRuntimeTurn; error: unknown } | undefined;
  try {
    for await (const message of frames) {
      if (runtime.abortController.signal.aborted) break;
      noteClaudeRuntimeFrame(runtime);
      const turn = routeClaudeFrame(runtime, message);
      try {
        await turn.handleMessage(message);
      } catch (error) {
        failure = { turn, error };
        break;
      }
    }
  } catch (error) {
    failure = { turn: runtime.latestTurn, error };
  } finally {
    endClaudeRuntime(runtime, failure);
    markEnded();
  }
}

/**
 * Settle everything a finished process owned and release its turns.
 *
 * The consumer ends either exhausted or through an abrupt exit, which invokes
 * `return()`, i.e. the SDK's `cleanup()` → `transport.close()`. So the handle
 * is dead either way: nothing more can arrive on it and `stopTask` would answer
 * a stop request with a transport error. Settle what it owned instead of
 * retaining a handle that can only fail, and never leave a task at `running`.
 */
function endClaudeRuntime(
  runtime: ClaudeRuntime,
  failure: { turn: ClaudeRuntimeTurn; error: unknown } | undefined,
): void {
  runtime.state = "ended";
  disarmClaudeRuntimeIdleDetach(runtime);
  // Nothing reads the held prompt any more; release it.
  runtime.input.close();
  const { session, control } = runtime;
  const killedBy =
    session.claudeRuntime === runtime && !runtime.abortController.signal.aborted
      ? killedClaudeProcessSignal(failure?.error)
      : undefined;
  if (session.claudeRuntime === runtime) session.claudeRuntime = undefined;
  // The latest turn's prompt can have settled already and the turn still hold
  // the foreground: the CLI resumed its root loop on its own. Nothing else is
  // waiting to hand that foreground back.
  const orphanedForeground =
    !runtime.waitingTurns.has(runtime.latestTurn) &&
    session.queryControl === control &&
    session.status === "running";
  // Released turns and spontaneous root loops no longer have a sendPrompt
  // catch that owns the foreground. Classify their death before task cleanup
  // and runtimeEnded remove the evidence that a continuation was owed.
  const interruptedOutsidePrompt =
    killedBy &&
    (orphanedForeground || session.abortController === undefined) &&
    (session.status === "running" ||
      (session.retainedContinuationRequestIds?.size ?? 0) > 0 ||
      claudeRuntimeOwesWork(runtime));
  if (interruptedOutsidePrompt) {
    session.status = "error";
    session.error = claudeProcessKilledMessage(killedBy);
    session.interruption = "restart";
    session.turnStartedAt = undefined;
    session.abortController = undefined;
    session.completionBlockedByBackgroundTasks = false;
    eventEmitter.emit({
      type: "session.error",
      sessionId: session.id,
      data: { error: session.error },
    });
  }
  removeBackgroundTaskCandidatesOwnedBy(session, control);
  // The handle is dead, so no edge can still arrive to claim these.
  forgetSettlingBackgroundTasksOwnedBy(session, control);
  const settled = settleTasksOwnedByClosedControl(
    session,
    control,
    "The Claude session that owned this task ended before it reported a result",
  );
  if (session.queryControl === control) session.queryControl = undefined;
  if (session.queryControlDraining === control) session.queryControlDraining = undefined;
  // Idempotent: the SDK has normally cleaned up already.
  void closeQueryControl(control);
  if (settled) emitBackgroundTaskSnapshot(session);
  // A turn that failed after it stopped waiting still ended the process; the
  // turn the user is waiting on is the one that has to say so.
  const failedTurn =
    failure && (runtime.waitingTurns.has(failure.turn) ? failure.turn : runtime.latestTurn);
  // The latest turn hears of it even when its prompt has settled, so that an
  // owed continuation dies with the process.
  const turns = new Set([...runtime.waitingTurns, runtime.latestTurn]);
  runtime.waitingTurns.clear();
  for (const turn of turns) {
    turn.runtimeEnded(turn === failedTurn && failure ? { error: failure.error } : undefined);
  }
  if (orphanedForeground && !interruptedOutsidePrompt)
    releaseOrphanedForeground(runtime, failure?.error);
  // Nothing this process ran can still be owed once it has ended.
  syncTurnInFlightMark(session);
}

/** Hand back a foreground no waiting prompt can settle; see `endClaudeRuntime`. */
function releaseOrphanedForeground(runtime: ClaudeRuntime, error: unknown): void {
  const { session } = runtime;
  const sessionId = session.id;
  session.turnStartedAt = undefined;
  session.abortController = undefined;
  session.completionBlockedByBackgroundTasks = false;
  if (error === undefined) {
    session.status = "idle";
    eventEmitter.emit({ type: "session.idle", sessionId, data: { success: true } });
    return;
  }
  console.error("[session-manager] Claude runtime ended under a resumed root turn", {
    sessionId,
  });
  session.status = "error";
  session.error = error instanceof Error ? error.message : String(error);
  eventEmitter.emit({ type: "session.error", sessionId, data: { error: session.error } });
}

/** Drop the claims a failed join made; the previous turn's work is untouched. */
function abandonJoin(turn: TurnState, running: ClaudeRuntime): void {
  const { session } = turn;
  turn.runtime = undefined;
  if (session.queryControl === running.control) session.queryControl = undefined;
  turn.queryIteratorControl = undefined;
  // A setup failure never authorizes killing or replacing shared work.
  // Leave the previous turn and retention intact; the turn's startup failure
  // handling restores foreground ownership.
}

/** Restate this turn's settings on the running CLI, and build its input. */
async function prepareJoin(turn: TurnState, plan: QueryPlan, running: ClaudeRuntime) {
  const { session, options } = turn;
  const { mcpServers, plugins, sdkPrompt, queryEnvironment, liveSettings, mcpServersKey } = plan;
  const required = mcpServers[AGENT_MCP_SERVER_NAME]
    ? [AGENT_MCP_SERVER_NAME, ...(options?.agentMcp?.design ? ["orkestrator-design"] : [])]
    : [];
  // Launch-only settings may have changed while this turn was preparing.
  await assertClaudeRuntimeAccepts(session, options, {
    ...claudeLaunchResourceProfile(plugins, queryEnvironment),
    settingSources: JSON.stringify(plan.settingSources),
  });
  // Held from here so the process is not closed as unused while the
  // settings below are applied.
  session.queryControl = running.control;
  turn.queryIteratorControl = running.control;
  try {
    await applyClaudeLiveSettings(running, liveSettings);
    await syncClaudeRuntimeMcp(running, {
      servers: mcpServers,
      key: mcpServersKey,
      names: plan.mcpServerNames,
      required,
    });
    recordMcpConfigRevision(session, plan, running.mcp);
    return await sdkPromptMessages(sdkPrompt, turn.promptUuid);
  } catch (error) {
    abandonJoin(turn, running);
    throw error;
  }
}

/** Write the prompt into the running CLI. */
function submitToRunningRuntime(
  turn: TurnState,
  running: ClaudeRuntime,
  messages: Awaited<ReturnType<typeof sdkPromptMessages>>,
): void {
  try {
    turn.runtime = running;
    if (!submitClaudeTurn(running, turn.thisTurn!, messages)) {
      throw sessionOperationError(
        "conflict",
        "Claude runtime could not accept prompt input; retry after it has stopped",
      );
    }
  } catch (error) {
    abandonJoin(turn, running);
    throw error;
  }
}

/**
 * Wait until a new CLI may open the session's rollout. Answers false when the
 * turn must not launch one after all.
 */
async function prepareLaunch(turn: TurnState): Promise<boolean> {
  const { session, sessionId, abortController } = turn;
  // Stopped while joining a process that was ending: nothing was written,
  // and stopping must not start another one.
  if (abortController.signal.aborted) return false;
  // A previous CLI that is still exiting must be gone before another one
  // opens the same rollout.
  await retireDrainingClaudeRuntime(session);
  return !(
    abortController.signal.aborted ||
    session.deleting ||
    sessions.get(sessionId) !== session
  );
}

/** Launch the session's CLI with this turn as its first. */
function launchClaudeRuntime(turn: TurnState, plan: QueryPlan) {
  const { session, options, abortController, stream } = turn;
  const { plugins, sdkPrompt, queryEnvironment, mcpServers, mcpServerNames, mcpServersKey } = plan;
  const heldSdkPrompt = holdSdkPromptOpen(sdkPrompt, abortController.signal, turn.promptUuid);
  // Created before the query so the hooks it launches with read this state.
  const mcp = createClaudeRuntimeMcp(mcpServers, mcpServerNames);
  // Hooks and callbacks fire on the runtime's behalf for whichever turn
  // they concern: the one whose row holds the tool, else the latest turn.
  const turnFor = (toolUseId?: string): ClaudeRuntimeTurn =>
    (toolUseId ? turn.runtime?.toolOwners.get(toolUseId) : undefined) ??
    turn.runtime?.latestTurn ??
    turn.thisTurn!;
  const queryIterator = query({
    prompt: heldSdkPrompt.prompt,
    options: claudeQueryOptions(turn, plan, turnFor, mcp),
  });
  const liveQuery = Object.assign(queryIterator, {
    pushInput: (message: SDKUserMessage) => turnFor().pushSteerInput(message),
  });
  const created = createClaudeRuntime({
    session,
    control: liveQuery,
    heldInput: heldSdkPrompt,
    abortController,
    toolTracker: stream.toolTracker,
    activeTaskIds: stream.activeTaskIds,
    launch: {
      ...claudeLaunchedProfile(session, options),
      settingSources: JSON.stringify(plan.settingSources),
      ...claudeLaunchResourceProfile(plugins, queryEnvironment),
    },
    mcpServers: mcpServersKey,
    mcp,
    firstTurn: turn.thisTurn!,
  });
  const launched = created.runtime;
  turn.runtime = launched;
  session.claudeRuntime = launched;
  session.queryControl = liveQuery;
  turn.queryIteratorControl = liveQuery;
  recordMcpConfigRevision(session, plan, mcp);
  return { launched, queryIterator, markEnded: created.markEnded };
}

async function readSupportedAgents(
  queryIterator: ReturnType<typeof query>,
): Promise<ClaudeRuntime["supportedAgents"] | undefined> {
  try {
    return (await queryIterator.supportedAgents()).map((agent) => ({
      name: agent.name,
      description: agent.description,
      model: agent.model,
    }));
  } catch (error) {
    debugLog("[session-manager] Agent discovery unavailable:", error);
    return undefined;
  }
}

/** The SDK has the turn: start its per-turn reads and hand it the abort. */
function markQueryStarted(turn: TurnState, testHooks: PromptTestHooks | undefined): void {
  const { session, sessionId, abortController, diagnostics } = turn;
  const control = turn.queryIteratorControl!;
  const turnRuntime = turn.runtime!;
  // Abort ownership follows the turn: stopping the latest turn stops the
  // process it runs on, exactly as stopping a turn that launched it does.
  abortController.signal.addEventListener(
    "abort",
    () => {
      if (turnRuntime.latestTurn === turn.thisTurn) turnRuntime.abortController.abort();
    },
    { once: true },
  );
  session.finishTurnInputIfSettled = turn.finishTurnInputForThisTurn;
  turn.queryStarted = true;
  // From here a restart cuts the turn short rather than losing it unsent.
  syncTurnInFlightMark(session, { started: true });
  testHooks?.onQueryStarted?.();
  // One control read per turn, off the message path, so the inventory a
  // selected command is validated against is the session's own.
  readLiveCommandInventory(session, control);
  reportUltracodeRuntime(session, control);

  turn.structuredUsageRefresh = createStructuredUsageRefreshCoordinator(session, control);
  // Prime the limits panel as soon as the live control channel is ready.
  // This intentionally runs off the SDK message-consumer path.
  void turn.structuredUsageRefresh?.trigger();

  diagnostics?.sent(sessionId);
}

/**
 * The running CLI this turn joins, or undefined when it launches one.
 *
 * A warm CLI that owes nothing and was launched with other launch-only
 * settings is retired rather than refused: `prepareLaunch` closes its input and
 * waits for it to exit before the new one starts. One that still owes work is
 * returned, and joining it answers 409 (`assertClaudeRuntimeAccepts`).
 */
function joinableRuntime(turn: TurnState, plan: QueryPlan): ClaudeRuntime | undefined {
  const running = openClaudeRuntime(turn.session);
  if (!running || claudeRuntimeOwesWork(running)) return running;
  const requested = {
    ...claudeLaunchProfile(turn.session, turn.options),
    settingSources: JSON.stringify(plan.settingSources),
    ...claudeLaunchResourceProfile(plan.plugins, plan.queryEnvironment),
  };
  return claudeLaunchConflict(running.launch, requested) ? undefined : running;
}

/**
 * Put this turn on the session's CLI: written into the running one, or as the
 * first turn of a new one. Answers false when it was stopped before either.
 */
export async function runTurnOnRuntime(
  turn: TurnState,
  plan: QueryPlan,
  testHooks: PromptTestHooks | undefined,
): Promise<boolean> {
  turn.thisTurn = createClaudeRuntimeTurn(turn);
  // The session's CLI is still running after an earlier turn: warm, or owning
  // background work. This prompt is written into that process: a second CLI
  // resumed from the same rollout would run its own root loop beside it.
  const running = joinableRuntime(turn, plan);
  if (running) {
    const messages = await prepareJoin(turn, plan, running);
    submitToRunningRuntime(turn, running, messages);
  }
  if (!turn.runtime) {
    if (!(await prepareLaunch(turn))) return false;
    const { launched, queryIterator, markEnded } = launchClaudeRuntime(turn, plan);
    if (typeof queryIterator.supportedAgents === "function") {
      const agents = await readSupportedAgents(queryIterator);
      if (agents) launched.supportedAgents = agents;
    }
    void consumeClaudeRuntime(launched, queryIterator, markEnded);
  }
  markQueryStarted(turn, testHooks);
  return true;
}
