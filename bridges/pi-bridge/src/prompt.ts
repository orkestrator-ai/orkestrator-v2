import { createBridgeDiagnostics } from "@orkestrator/protocol/bridge-diagnostics";
/**
 * Running one turn.
 *
 * The turn is where at-most-once matters. A prompt whose acknowledgement is
 * lost must never be re-sent on a guess, so this module keeps a durable
 * journal of every request id it has taken and refuses to reuse one whose
 * outcome a previous bridge process could not record.
 */
import { tryParseStructuredOutputText } from "@orkestrator/protocol/structured-output";
import type { AgentSession, ContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";
import {
  MAX_PROMPT_JOURNAL,
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  PROMPT_TIMEOUT_MS,
  PROVIDER,
} from "./config.js";
import { runDeferredCommandReload } from "./agent-session.js";
import { beginCommandRun, settleCommandRun } from "./commands.js";
import { denyAllApprovals } from "./interactions.js";
import { getLastAssistantUsage } from "./pi-sdk.js";
import { schedulePersist } from "./persistence.js";
import { boundTranscript } from "./transcript.js";
import { TimeoutError, withTimeout } from "./timeout.js";
import {
  setSteerJournal,
  type JsonObject,
  type PiCommandRun,
  type PromptJournalEntry,
  type SessionState,
} from "./state.js";

export const STRUCTURED_PROMPT_INSTRUCTION_PREFIX = "End your turn with exactly one JSON value";

export function structuredPromptInstruction(schema: JsonObject): string {
  return `${STRUCTURED_PROMPT_INSTRUCTION_PREFIX} matching this JSON Schema. That final message must be the JSON value alone, with no Markdown fence and no commentary around it.\n\nBefore that final message you may send ordinary prose progress updates. Keep them plain sentences: never send a JSON object or array as a progress update, and never draft or preview the final value.\n\n${JSON.stringify(schema)}`;
}

export interface PromptImage {
  mimeType: string;
  data: string;
}

export interface DispatchInput {
  prompt: string;
  images: PromptImage[];
  schema?: JsonObject;
  requestId?: string;
  /**
   * `false` is literal intent, passed to Pi as `expandPromptTemplates: false`:
   * no extension command dispatch, no skill and no template expansion.
   */
  expandCommands?: boolean;
  /**
   * Set when Pi will run this text as an extension command (see
   * `effectiveCommandKind`); the canonical invocation name.
   */
  extensionCommand?: string;
}

export interface DispatchHandle {
  /** Settles when the turn reaches a terminal state. Never rejects. */
  completion: Promise<void>;
}

/**
 * Hand the turn to Pi and follow it to completion.
 *
 * Resolves as soon as the prompt has been *accepted*, handing back the rest of
 * the turn inside {@link DispatchHandle}. `AgentSession.prompt` resolves only
 * when the whole run is over, so acceptance is observed through its own
 * preflight callback: that is the moment the prompt is provably on its way and
 * the moment the HTTP route may answer 202.
 *
 * The wrapper around the completion promise is load-bearing. An async function
 * that returned the promise directly would have it flattened into its own
 * result, so the route would await the whole turn.
 */
export async function dispatchPrompt(
  state: SessionState,
  session: AgentSession,
  input: DispatchInput,
  promptTimeoutMs = PROMPT_TIMEOUT_MS,
): Promise<DispatchHandle> {
  const text = input.schema
    ? `${input.prompt}\n\n${structuredPromptInstruction(input.schema)}`
    : input.prompt;
  const promptSequence = state.promptSequence;
  const diagnostics = createBridgeDiagnostics("pi", state, () => ({
    pendingApprovals: state.approvals.size,
  }));
  state.diagnostics = diagnostics;

  let announceAccepted: (accepted: boolean) => void = () => undefined;
  const accepted = new Promise<boolean>((resolve) => {
    announceAccepted = resolve;
  });

  const commandRun = input.extensionCommand
    ? beginCommandRun(state, input.extensionCommand)
    : undefined;
  let run: Promise<void>;
  try {
    run = session.prompt(text, {
      ...(input.images.length > 0 ? { images: input.images.map(toImageContent) } : {}),
      // Pi's one switch for command interpretation: it gates extension command
      // dispatch, `/skill:` expansion and template expansion together. On by
      // default so a `/command` typed in the composer behaves exactly as it
      // does in a Pi terminal tab; off for literal (workflow, mail) prompts.
      expandPromptTemplates: input.expandCommands !== false,
      // Not "interactive": a person typed this, but there is no terminal behind
      // it, so an extension that would draw a dialog has to know it cannot.
      source: "rpc",
      preflightResult: (success) => announceAccepted(success),
    });
  } catch (error) {
    if (commandRun && state.commandRun === commandRun) state.commandRun = undefined;
    diagnostics?.terminalSettled("rejected");
    diagnostics?.streamSettled("rejected");
    diagnostics?.close("send-failed");
    if (state.diagnostics === diagnostics) state.diagnostics = undefined;
    throw error;
  }

  // Pi calls an extension command's handler synchronously inside `prompt()`,
  // before its first await, and reports preflight only once the handler has
  // *returned* — which for a long-running command is the end of its work, not
  // its start. The handler is already running here, so the command is
  // accepted now; waiting for preflight would hold the HTTP request (and the
  // at-most-once window) open for as long as the command runs.
  if (commandRun) announceAccepted(true);

  // A rejection before preflight ran — no model, no credential — must not leave
  // the caller awaiting acceptance forever.
  const settled = run.then(
    () => {
      announceAccepted(true);
    },
    () => {
      diagnostics?.terminalSettled("rejected");
      diagnostics?.streamSettled("rejected");
      announceAccepted(false);
    },
  );

  if (!(await accepted)) {
    // Pi refused the prompt outright. Surface whatever it refused with, rather
    // than a generic rejection: it is the only thing that says why.
    await settled;
    if (commandRun && state.commandRun === commandRun) state.commandRun = undefined;
    diagnostics?.terminalSettled("rejected");
    diagnostics?.streamSettled("rejected");
    diagnostics?.close("send-failed");
    if (state.diagnostics === diagnostics) state.diagnostics = undefined;
    await run;
    throw new Error("Pi rejected the prompt");
  }

  diagnostics?.sent(state.id);
  // `abort()` stops a model run, but nothing can stop an extension command's
  // handler. Cancelling one settles the turn here instead of leaving the tab
  // running until the handler chooses to return.
  let cancelCommand: () => void = () => undefined;
  const commandCancelled = new Promise<void>((resolve) => {
    cancelCommand = resolve;
  });
  state.cancelTurn = async (reason = "user") => {
    if (commandRun) {
      commandRun.cancelled = true;
      cancelCommand();
    }
    await (diagnostics
      ? diagnostics.cancel({ cancel: () => session.abort() }, reason)
      : session.abort().catch(() => undefined));
  };

  // Never rejects: every terminal path is recorded on the session, and an
  // unobserved rejection here would take the whole bridge down.
  return {
    completion: followRun(
      state,
      session,
      run,
      promptSequence,
      input,
      promptTimeoutMs,
      commandRun ? { run: commandRun, cancelled: commandCancelled } : undefined,
    ).finally(() => {
      diagnostics?.close();
      if (state.diagnostics === diagnostics) state.diagnostics = undefined;
    }),
  };
}

async function followRun(
  state: SessionState,
  session: AgentSession,
  run: Promise<void>,
  promptSequence: number,
  input: DispatchInput,
  promptTimeoutMs: number,
  command?: { run: PiCommandRun; cancelled: Promise<void> },
): Promise<void> {
  const commandRun = command?.run;
  try {
    const work = command
      ? Promise.race([run.then(() => awaitExtensionWork(session)), command.cancelled])
      : run;
    await withTimeout(work, promptTimeoutMs, "The Pi turn exceeded its time budget");
    if (!turnStillOwned(state, promptSequence)) return;
    state.diagnostics?.terminalSettled("resolved");
    state.diagnostics?.streamSettled("resolved");
    const commandError = commandRun
      ? settleCommandRun(state, commandRun, input.requestId)
      : undefined;
    if (commandError !== undefined) {
      failTurn(state, session, commandError, input);
      return;
    }
    finishTurn(state, session, input);
  } catch (error) {
    state.diagnostics?.terminalSettled("rejected");
    state.diagnostics?.streamSettled("rejected");
    state.diagnostics?.checkpoint("cancelling");
    // The timeout rejects the wait, not the run: `session.prompt` is still
    // executing, and `settleTurn` is about to drop the only handle that can
    // stop it. Deny parked tool calls before aborting: abort may tear down the
    // hook that owns their promises, but teardown is never consent to run.
    denyAllApprovals(state, "The turn ended before this tool call was approved.");
    // Aborting is what keeps a timed-out turn from continuing
    // to write into the transcript of a session the user has been told
    // failed — and from interleaving its deltas into the next turn's message.
    // Awaited so the abort has landed before the session is reported idle.
    try {
      await state.cancelTurn?.(error instanceof TimeoutError ? "timeout" : "turn-ended");
    } catch {
      // Best-effort. A session that will not abort still has to reach a
      // terminal state here, or the tab stays "running" forever.
    }
    if (!turnStillOwned(state, promptSequence)) return;
    if (commandRun) {
      commandRun.error ??= errorText(error);
      settleCommandRun(state, commandRun, input.requestId);
    }
    failTurn(state, session, error, input);
  } finally {
    if (commandRun && state.commandRun === commandRun) state.commandRun = undefined;
  }
}

/**
 * Wait out work an extension command started but did not await.
 *
 * The handler returning is not proof the command is done:
 * `pi.sendMessage(..., { triggerTurn: true })` marks a run active
 * synchronously, and `pi.sendUserMessage` starts one after its own preflight
 * awaits. One macrotask lets a run the handler just started claim the session,
 * then Pi's own idle signal (`isIdle` / `waitForIdle`, settled by
 * `agent_settled`) says when it is over. Bounded by the caller's turn timeout.
 */
async function awaitExtensionWork(session: AgentSession): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (session.isIdle === false && typeof session.waitForIdle === "function") {
    await session.waitForIdle();
  }
}

/** Reload anything a busy refresh deferred, now that the turn has settled. */
function afterTurnSettled(state: SessionState): void {
  void runDeferredCommandReload(state)
    .then(() => schedulePersist())
    .catch(() => undefined);
}

function finishTurn(state: SessionState, session: AgentSession, input: DispatchInput): void {
  settleTurn(state, session);
  // A cancelled turn is not an error: the user asked for it, and the partial
  // transcript is the honest record of what ran.
  state.status = "idle";
  state.error = undefined;
  recordUsage(state, input);
  recordStructuredOutput(state, session, input, true);
  journal(state, input.requestId, "completed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
  afterTurnSettled(state);
}

function failTurn(
  state: SessionState,
  session: AgentSession,
  error: unknown,
  input: DispatchInput,
): void {
  settleTurn(state, session);
  state.status = "error";
  state.error = errorText(error);
  recordUsage(state, input);
  recordStructuredOutput(state, session, input, false);
  journal(state, input.requestId, "failed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
  afterTurnSettled(state);
}

/**
 * Release everything the finished turn was holding.
 *
 * The approvals matter most: a turn that ended while a tool call was parked
 * left that call awaiting a promise nothing will settle. Denying is the only
 * safe answer — the turn it belonged to is over, so running the tool now would
 * execute against a run that no longer exists.
 */
function settleTurn(state: SessionState, session: AgentSession): void {
  denyAllApprovals(state, "The turn ended before this tool call was approved.");
  if (state.pendingSteerDeliveries.length > 0) {
    // Pi retains an undrained steer in the Agent queue after abort/end. It
    // would otherwise be consumed by a later ordinary prompt, violating the
    // same-run contract. There is no selective public removal API; at this
    // terminal boundary every legitimate follow-up should already be drained.
    let cleared = false;
    try {
      session.clearQueue();
      cleared = true;
    } catch {
      // The bridge record remains ambiguous, never accepted, if cleanup fails.
    }
    for (const pending of state.pendingSteerDeliveries) {
      const entry = state.steerJournal.get(pending.requestId);
      if (entry && entry.state !== "delivered") {
        setSteerJournal(state, { ...entry, state: cleared ? "dropped" : "ambiguous" });
      }
    }
    state.pendingSteerDeliveries = [];
    state.queue.steering = [];
  }
  state.cancelTurn = undefined;
  state.compacting = false;
}

/**
 * Record what the finished turn cost.
 *
 * Context occupancy is read from the live session rather than summed here: Pi
 * accounts for compaction, so the number it reports is what the *next* turn
 * will actually send, which is the question the usage meter is asking.
 */
function recordUsage(state: SessionState, input: DispatchInput): void {
  const session = state.session;
  const branch = session?.sessionManager?.getBranch() ?? [];
  const assistantUsage = getLastAssistantUsage(branch);
  const turn = assistantUsage
    ? {
        inputTokens: assistantUsage.input,
        outputTokens: assistantUsage.output,
        cacheReadTokens: assistantUsage.cacheRead,
        cacheWriteTokens: assistantUsage.cacheWrite,
        ...(assistantUsage.reasoning === undefined
          ? {}
          : { reasoningTokens: assistantUsage.reasoning }),
      }
    : state.currentTurnUsage;
  const elapsed = state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined;
  const context = readContextUsage(state);
  const stats = readSessionStats(state);
  const sessionTokens =
    stats && typeof stats.tokens?.total === "number" && Number.isFinite(stats.tokens.total)
      ? stats.tokens.total
      : undefined;
  const previous = state.usage;
  if (turn && Object.keys(turn).length > 0) {
    const turnId =
      [...branch]
        .reverse()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.usage !== undefined,
        )?.id ??
      input.requestId ??
      `turn-${state.promptSequence}`;
    const sessionCost = stats?.cost;
    const turnCost =
      sessionCost === undefined
        ? assistantUsage?.cost.total
        : Math.max(0, sessionCost - (previous?.costUsd ?? 0));
    const toolCalls =
      stats === undefined
        ? undefined
        : Math.max(0, stats.toolCalls - (previous?.sessionToolCalls ?? 0));
    const totalTokens =
      assistantUsage?.totalTokens ??
      (turn.inputTokens ?? 0) +
        (turn.outputTokens ?? 0) +
        (turn.cacheReadTokens ?? 0) +
        (turn.cacheWriteTokens ?? 0);
    const turnEntry = {
      turnId,
      ...(turnCost === undefined ? {} : { costUsd: turnCost }),
      ...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens }),
      ...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens }),
      ...(turn.cacheReadTokens === undefined ? {} : { cacheReadTokens: turn.cacheReadTokens }),
      ...(turn.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: turn.cacheWriteTokens }),
      ...(turn.reasoningTokens === undefined ? {} : { reasoningTokens: turn.reasoningTokens }),
      totalTokens,
      ...(elapsed === undefined ? {} : { durationMs: elapsed }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
    };
    state.usage = {
      turn,
      turns: [
        ...(previous?.turns ?? []).filter((entry) => entry.turnId !== turnId),
        turnEntry,
      ].slice(-20),
      ...(sessionTokens === undefined ? {} : { sessionTokens }),
      ...(stats && typeof stats.toolCalls === "number"
        ? { sessionToolCalls: stats.toolCalls }
        : {}),
      ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
      ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
      ...context,
      ...(sessionCost === undefined ? readCost(state) : { costUsd: sessionCost }),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentTurnUsage = undefined;
  state.turnStartedAt = undefined;
}

function readSessionStats(state: SessionState): SessionStats | undefined {
  try {
    return state.session?.getSessionStats();
  } catch {
    return undefined;
  }
}

/**
 * Read Pi's own context accounting.
 *
 * `ContextUsage` is a typed SDK export — `{ tokens, contextWindow, percent }` —
 * so the fields are read directly rather than probed. `tokens` is documented as
 * `null` right after a compaction, before the next model response re-establishes
 * a real count. That is not "unknown source", it is "known to be stale", so it
 * is reported as `estimated` and the caller falls back to the per-turn sum. The
 * previous probe silently switched to a differently-scoped number and presented
 * it as an exact whole-session total.
 */
function readContextUsage(state: SessionState): {
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  estimated?: boolean;
} {
  try {
    const usage: ContextUsage | undefined = state.session?.getContextUsage();
    if (!usage) return {};
    const { tokens, contextWindow, percent } = usage;
    const window =
      typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {};
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
      return { ...window, estimated: true };
    }
    return {
      contextTokens: tokens,
      ...window,
      ...(typeof percent === "number" && Number.isFinite(percent)
        ? { contextPercent: percent }
        : {}),
    };
  } catch {
    // Context accounting is a display nicety. A session that cannot report it
    // must not fail the turn that just succeeded.
    return {};
  }
}

function readCost(state: SessionState): { costUsd?: number } {
  try {
    const cost = state.session?.getSessionStats().cost;
    return typeof cost === "number" && Number.isFinite(cost) ? { costUsd: cost } : {};
  } catch {
    return {};
  }
}

/**
 * Resolve a schema-constrained turn.
 *
 * The final assistant text is the carrier, so this reads whatever the turn
 * actually produced rather than any summary field.
 */
function recordStructuredOutput(
  state: SessionState,
  session: AgentSession,
  input: DispatchInput,
  completed: boolean,
): void {
  const { schema, requestId } = input;
  if (!schema || !requestId) return;
  // The SDK owns the canonical assistant message. Reading it after a completed
  // run avoids maintaining a second, delta-assembled copy in bridge state.
  // A failed run deliberately does not read it: it may still name the previous
  // turn, which must never satisfy this request's schema.
  const output = completed ? (session.getLastAssistantText()?.trim() ?? "") : "";

  if (Buffer.byteLength(output) > MAX_STRUCTURED_RESULT_BYTES) {
    setStructuredResult(state, requestId, {
      ok: false,
      provider: PROVIDER,
      requestId,
      error: {
        code: "malformed_output",
        message: "Structured output exceeded the size limit",
        provider: PROVIDER,
        retryable: true,
      },
    });
    return;
  }
  const parsed = tryParseStructuredOutputText(output);
  setStructuredResult(
    state,
    requestId,
    parsed === undefined
      ? {
          ok: false,
          provider: PROVIDER,
          requestId,
          error: {
            code: "malformed_output",
            message: "The turn did not end with a JSON value",
            provider: PROVIDER,
            retryable: true,
          },
        }
      : { ok: true, provider: PROVIDER, requestId, value: parsed },
  );
}

export function setStructuredResult(state: SessionState, requestId: string, value: unknown): void {
  state.structured.set(requestId, value);
  // Bounded: a long-lived session running structured turns would otherwise
  // retain every result it has ever produced for the life of the bridge.
  while (state.structured.size > MAX_STRUCTURED_RESULTS) {
    const oldest = state.structured.keys().next();
    if (oldest.done) break;
    state.structured.delete(oldest.value);
  }
}

export function journal(
  state: SessionState,
  requestId: string | undefined,
  entryState: PromptJournalEntry["state"],
): void {
  if (!requestId) return;
  setPromptJournal(state, {
    requestId,
    state: entryState,
    acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
  });
}

export function setPromptJournal(state: SessionState, entry: PromptJournalEntry): void {
  state.promptJournal.delete(entry.requestId);
  state.promptJournal.set(entry.requestId, entry);
  while (state.promptJournal.size > MAX_PROMPT_JOURNAL) {
    const oldest = state.promptJournal.keys().next();
    if (oldest.done) break;
    state.promptJournal.delete(oldest.value);
  }
  schedulePersist();
}

/**
 * Whether the turn that produced this frame is still the session's live turn.
 *
 * A cancelled or superseded turn can keep emitting for a while: its run
 * outlives the request that abandoned it. Writing those frames into the
 * transcript would interleave a dead turn's output with the live one's.
 */
function turnStillOwned(state: SessionState, promptSequence: number): boolean {
  return state.promptSequence === promptSequence && state.status === "running";
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The Pi turn failed";
}

function toImageContent(image: PromptImage): {
  type: "image";
  data: string;
  mimeType: string;
} {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}
