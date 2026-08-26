/**
 * Running one turn.
 *
 * The turn is where at-most-once matters. A prompt whose acknowledgement is
 * lost must never be re-sent on a guess, so this module keeps a durable
 * journal of every request id it has taken and refuses to reuse one whose
 * outcome a previous bridge process could not record.
 */
import { tryParseStructuredOutputText } from "@orkestrator/protocol/structured-output";
import type { ModelSelection, SDKAgent, SDKImage, TokenUsage } from "@cursor/sdk";
import {
  CANCEL_ACK_TIMEOUT_MS,
  CATALOG_TIMEOUT_MS,
  MAX_PROMPT_JOURNAL,
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  PROMPT_TIMEOUT_MS,
  PROVIDER,
} from "./config.js";
import { modelSelection } from "./models.js";
import { schedulePersist } from "./persistence.js";
import { applyInteractionUpdate, settleBackgroundChildren } from "./translate.js";
import { boundTranscript } from "./transcript.js";
import {
  type JsonObject,
  type PromptJournalEntry,
  type SessionState,
  type TurnUsage,
  isObject,
} from "./state.js";

export const STRUCTURED_PROMPT_INSTRUCTION_PREFIX = "End your turn with exactly one JSON value";

export function structuredPromptInstruction(schema: JsonObject): string {
  return `${STRUCTURED_PROMPT_INSTRUCTION_PREFIX} matching this JSON Schema. That final message must be the JSON value alone, with no Markdown fence and no commentary around it.\n\nBefore that final message you may send ordinary prose progress updates. Keep them plain sentences: never send a JSON object or array as a progress update, and never draft or preview the final value.\n\n${JSON.stringify(schema)}`;
}

export interface DispatchInput {
  prompt: string;
  images: Array<{ mimeType: string; data: string }>;
  schema?: JsonObject;
  requestId?: string;
}

export interface DispatchHandle {
  /** Settles when the turn reaches a terminal state. Never rejects. */
  completion: Promise<void>;
}

/**
 * Hand the turn to the SDK and follow it to completion.
 *
 * Resolves as soon as the run has been *started*, handing back the rest of the
 * turn inside {@link DispatchHandle}. The wrapper is load-bearing: an async
 * function that returned the promise directly would have it flattened into its
 * own result, so the HTTP route would await the whole turn instead of
 * answering 202 the moment the request is provably on its way.
 */
export async function dispatchPrompt(
  state: SessionState,
  agent: SDKAgent,
  input: DispatchInput,
): Promise<DispatchHandle> {
  const text = input.schema
    ? `${input.prompt}\n\n${structuredPromptInstruction(input.schema)}`
    : input.prompt;
  const images: SDKImage[] = input.images.map((image) => ({
    data: image.data,
    mimeType: image.mimeType,
  }));

  const promptSequence = state.promptSequence;
  const run = await agent.send(
    { text, ...(images.length > 0 ? { images } : {}) },
    {
      // Sent every turn rather than only at attach. The composer selection can
      // change in the same action that sends the prompt, and an agent is
      // created once but lives across many turns — without this, a model or
      // mode the user picked would not apply until something re-attached.
      model: modelSelection(state.composer),
      mode: state.composer.selectedModeId === "plan" ? "plan" : "agent",
      // Never awaited by the SDK's producer in a way that can stall the run,
      // and never awaited by us: every branch of `applyInteractionUpdate` is
      // synchronous, so a large transcript cannot back-pressure the agent.
      onDelta: ({ update }) => {
        if (!turnStillOwned(state, promptSequence)) return;
        applyInteractionUpdate(state, update);
      },
      ...(input.requestId ? { idempotencyKey: input.requestId } : {}),
    },
  );

  state.cancelTurn = async () => {
    await run.cancel().catch(() => undefined);
  };

  // The user cancelled while `send` was still open, so this turn was stopped
  // before it had anything to stop. Honour it now rather than letting a turn
  // the user already abandoned run to completion.
  if (state.pendingCancelPromptSequence === promptSequence) {
    state.pendingCancelPromptSequence = undefined;
    await run.cancel().catch(() => undefined);
  }

  // Never rejects: every terminal path is recorded on the session, and an
  // unobserved rejection here would take the whole bridge down.
  return { completion: followRun(state, run, promptSequence, input) };
}

export interface FollowableRun {
  stream(): AsyncGenerator<unknown, void>;
  cancel(): Promise<void>;
  wait(): Promise<TerminalRunResult>;
}

interface TerminalRunResult {
  status: string;
  result?: string;
  error?: { message: string };
  durationMs?: number;
  model?: ModelSelection;
  usage?: TokenUsage;
}

/**
 * Drive the run to its terminal state.
 *
 * The stream is drained even though `onDelta` is what builds the transcript.
 * Draining is what guarantees the run makes progress in SDK versions where the
 * stream is the consumer that pulls it, and it costs nothing when it is not.
 *
 * `timeoutMs` is a parameter rather than a direct read of `PROMPT_TIMEOUT_MS`
 * because the budget is a policy input, and one with a deliberate one-minute
 * floor: a test cannot lower it through the environment, and the branch it
 * guards — abandoning a run that is still executing — is the one that most
 * needs proving.
 */
export async function followRun(
  state: SessionState,
  run: FollowableRun,
  promptSequence: number,
  input: DispatchInput,
  timeoutMs: number = PROMPT_TIMEOUT_MS,
  cancelAckTimeoutMs: number = CANCEL_ACK_TIMEOUT_MS,
): Promise<void> {
  const terminal = run.wait();
  const streamed: StreamedUsage = {};
  const drained = (async () => {
    try {
      for await (const event of run.stream()) {
        // `onDelta` remains the transcript source. Consuming here primarily
        // keeps a pull-driven stream advancing. Usage is the exception: it also
        // has a first-class SDK message shape, and some local runtimes publish
        // that without a usage-bearing delta.
        const message = streamMessageUsage(event);
        if (!message) continue;
        streamed.total = sumTurnUsage(streamed.total, message);
        // Kept separately because the two answer different questions: the sum
        // is what the turn spent, the last message is what the context window
        // held when it ended.
        streamed.last = message;
      }
    } catch {
      // A stream failure is reported authoritatively by `wait()` below.
    }
  })();

  try {
    const result = await withTimeout(terminal, timeoutMs);
    await drained;
    if (!turnStillOwned(state, promptSequence)) return;
    finishTurn(state, result, input, streamed);
  } catch (error) {
    // Giving up on the wait is not the same as the run stopping. Failing the
    // turn here clears `cancelTurn` and settles every background child, so a
    // run left alive would keep writing to the workspace while `/activity`
    // answers idle and the user has lost the only control that could stop it.
    //
    // A timeout asks the SDK to cancel, but the SDK's terminal result remains
    // authoritative. Until it arrives the process may still be writing to the
    // workspace, so keep the turn running and keep its cancel handle exposed.
    // Cancellation is given a bounded grace period; if the SDK never produces a
    // terminal result, the turn is failed explicitly rather than held running
    // forever.
    if (error instanceof TurnTimeoutError) {
      void run.cancel().catch(() => undefined);
      if (!turnStillOwned(state, promptSequence)) return;
      state.error = error.message;
      state.revision += 1;
      schedulePersist();

      try {
        const result = await withTimeout(terminal, cancelAckTimeoutMs);
        await drained;
        if (!turnStillOwned(state, promptSequence)) return;
        finishTurn(state, result, input, streamed);
      } catch (terminalError) {
        if (!turnStillOwned(state, promptSequence)) return;
        // The cancellation was requested but the SDK never produced a terminal
        // result. Holding the session "running" forever would wedge the
        // environment, so fail explicitly — and say why — rather than pretend
        // the turn stopped when it provably did not.
        if (terminalError instanceof TurnTimeoutError) {
          failTurn(
            state,
            new Error("The Cursor turn did not stop after cancellation was requested"),
            input,
            undefined,
            streamed,
          );
          return;
        }
        failTurn(state, terminalError, input, undefined, streamed);
      }
      return;
    }
    if (!turnStillOwned(state, promptSequence)) return;
    failTurn(state, error, input, undefined, streamed);
  }
}

/** The turn outlived its budget, as opposed to the run reporting a failure. */
export class TurnTimeoutError extends Error {
  override readonly name = "TurnTimeoutError";

  constructor() {
    super("The Cursor turn exceeded its time budget");
  }
}

function finishTurn(
  state: SessionState,
  result: TerminalRunResult,
  input: DispatchInput,
  streamed: StreamedUsage,
): void {
  settleBackgroundChildren(state);
  state.cancelTurn = undefined;
  state.pendingCancelPromptSequence = undefined;

  if (result.status === "error") {
    failTurn(
      state,
      new Error(result.error?.message ?? "The Cursor turn failed"),
      input,
      result,
      streamed,
    );
    return;
  }

  // A cancelled turn is not an error: the user asked for it, and the partial
  // transcript is the honest record of what ran.
  state.status = "idle";
  state.error = undefined;
  recordUsage(state, result, streamed);
  recordStructuredOutput(state, result.result, input);
  journal(state, input.requestId, "completed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

function failTurn(
  state: SessionState,
  error: unknown,
  input: DispatchInput,
  result?: TerminalRunResult,
  streamed: StreamedUsage = {},
): void {
  settleBackgroundChildren(state);
  state.cancelTurn = undefined;
  state.pendingCancelPromptSequence = undefined;
  state.status = "error";
  state.error = errorText(error);
  recordUsage(state, result, streamed);
  recordStructuredOutput(state, undefined, input);
  journal(state, input.requestId, "failed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

/**
 * Usage observed on the run's own message stream.
 *
 * The two fields are different quantities and neither substitutes for the
 * other: `total` is what the whole turn spent, `last` is what the context
 * window held when it ended.
 */
interface StreamedUsage {
  total?: TurnUsage;
  last?: TurnUsage;
}

function recordUsage(
  state: SessionState,
  result: TerminalRunResult | undefined,
  streamed: StreamedUsage,
): void {
  // `RunResult.usage` is the SDK's authoritative cumulative usage for the run.
  // Local runs may omit usage from the `turn-ended` delta while still
  // publishing it here, which used to leave the bridge with no snapshot at
  // all. Prefer the terminal value when it exists and retain the delta
  // accumulator as a compatibility fallback for older SDK/runtime pairs.
  const turn = terminalTurnUsage(result?.usage) ?? streamed.total ?? state.currentTurnUsage;
  // The occupancy figure, which is a different question from the spend above:
  // `RunResult.usage` sums every model call the run made, so on a run with
  // several calls it is a multiple of anything the window ever held. Only a
  // single call's own snapshot answers "how full is the context", and the last
  // one is the one still standing when the turn ended.
  const context = streamed.last ?? state.currentTurnUsage;
  const elapsed =
    result?.durationMs ?? (state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined);
  const modelId = result?.model?.id ?? state.composer.selectedModelId;
  if (turn && Object.keys(turn).length > 0) {
    state.usage = {
      turn,
      // Recorded only when it is genuinely a second reading. A run that
      // reported one snapshot hands the same object to both, and persisting a
      // duplicate would invite the two to drift apart across a trim.
      ...(context && context !== turn && Object.keys(context).length > 0 ? { context } : {}),
      ...(modelId ? { modelId } : {}),
      ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentTurnUsage = undefined;
  state.turnStartedAt = undefined;
  scheduleAgentUsageRefresh(state);
}

/**
 * Cursor's run result answers what the latest turn spent. `agent.getUsage()`
 * answers the other half of the SDK's usage surface: cumulative billed tokens
 * and the amount actually charged across this durable agent. Keep that account
 * read off the terminal path — a billing response that is slow or eventually
 * consistent must not hold the session busy after the run itself ended.
 */
const AGENT_USAGE_RETRY_DELAYS_MS = [2_000, 10_000] as const;

type AgentUsageRefreshResult = "complete" | "retry" | "stale";

function scheduleAgentUsageRefresh(state: SessionState): void {
  const agent = state.agent;
  const promptSequence = state.promptSequence;
  if (!agent || !state.usage) return;

  const run = async (retryIndex: number): Promise<void> => {
    const outcome = await refreshAgentUsage(state, agent, promptSequence);
    if (outcome !== "retry" || retryIndex >= AGENT_USAGE_RETRY_DELAYS_MS.length) return;
    const timer = setTimeout(
      () => void run(retryIndex + 1),
      AGENT_USAGE_RETRY_DELAYS_MS[retryIndex],
    );
    timer.unref();
  };
  void run(0);
}

/**
 * Merge Cursor's cumulative billed-usage view into the latest turn snapshot.
 *
 * Exported for a focused contract test. The parser remains structural on
 * purpose: an older vendored runtime can return a partial object, and usage is
 * supplemental information rather than a reason to fail an otherwise complete
 * turn.
 */
export async function refreshAgentUsage(
  state: SessionState,
  agent: Pick<SDKAgent, "getUsage">,
  promptSequence: number,
  timeoutMs: number = CATALOG_TIMEOUT_MS,
): Promise<AgentUsageRefreshResult> {
  if (state.promptSequence !== promptSequence || !state.usage) return "stale";

  const report = await optionalWithin(
    Promise.resolve().then(() => agent.getUsage()),
    timeoutMs,
  ).catch(() => undefined);
  if (state.promptSequence !== promptSequence || !state.usage) return "stale";
  if (!isObject(report)) return "retry";

  const totals = isObject(report.usage) ? report.usage : undefined;
  const reportedSessionTokens = nonNegativeNumber(totals?.totalTokens);
  // The billed endpoint is eventually consistent too. A cumulative total below
  // the turn already in hand is an older view, not a new session total.
  const sessionTokens =
    reportedSessionTokens !== undefined &&
    reportedSessionTokens >= usageTokenTotal(state.usage.turn)
      ? reportedSessionTokens
      : undefined;
  const cost = isObject(report.cost) ? report.cost : undefined;
  const chargedCents = nonNegativeNumber(cost?.chargedCents);
  if (sessionTokens === undefined && chargedCents === undefined) return "retry";

  const costUsd = chargedCents === undefined ? undefined : chargedCents / 100;
  const current = state.usage;
  const nextSessionTokens = sessionTokens ?? current.sessionTokens;
  const nextCostUsd = costUsd ?? current.costUsd;
  const changed = nextSessionTokens !== current.sessionTokens || nextCostUsd !== current.costUsd;
  if (changed) {
    state.usage = {
      ...current,
      ...(nextSessionTokens === undefined ? {} : { sessionTokens: nextSessionTokens }),
      ...(nextCostUsd === undefined ? {} : { costUsd: nextCostUsd }),
      updatedAt: new Date().toISOString(),
    };
    state.revision += 1;
    schedulePersist();
  }

  // Cursor documents cost as eventually consistent. A token total with no cost
  // is a useful snapshot now, but gets two bounded follow-ups so a one-turn
  // session does not need another prompt before its final charge appears.
  return sessionTokens === undefined ||
    (chargedCents === undefined && current.costUsd === undefined)
    ? "retry"
    : "complete";
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageTokenTotal(usage: TurnUsage): number {
  return (
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
  );
}

async function optionalWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The categories `totalTokens` summarises, per the SDK's own `toTokenUsage`. */
const USAGE_CATEGORY_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

const TURN_USAGE_KEYS = [...USAGE_CATEGORY_KEYS, "reasoningTokens", "totalTokens"] as const;

function terminalTurnUsage(usage: unknown): TurnUsage | undefined {
  if (!isObject(usage)) return undefined;
  const turn: TurnUsage = {};
  for (const key of TURN_USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) turn[key] = value;
  }
  return Object.keys(turn).length > 0 ? turn : undefined;
}

function streamMessageUsage(message: unknown): TurnUsage | undefined {
  return isObject(message) && message.type === "usage"
    ? terminalTurnUsage(message.usage)
    : undefined;
}

function sumTurnUsage(
  current: TurnUsage | undefined,
  next: TurnUsage | undefined,
): TurnUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  const total: TurnUsage = {};
  for (const key of TURN_USAGE_KEYS) {
    if (key === "totalTokens") continue;
    if (current[key] !== undefined || next[key] !== undefined) {
      total[key] = (current[key] ?? 0) + (next[key] ?? 0);
    }
  }
  // Recomputed rather than added. `terminalTurnUsage` accepts a partial usage
  // object on purpose, so a message that omitted `totalTokens` would otherwise
  // leave the running total covering a different subset of messages than the
  // categories it claims to summarise — and `publicContextUsage` trusts it
  // over those categories.
  const summed = USAGE_CATEGORY_KEYS.filter((key) => total[key] !== undefined);
  if (summed.length > 0) {
    total.totalTokens = summed.reduce((sum, key) => sum + (total[key] ?? 0), 0);
  } else if (current.totalTokens !== undefined || next.totalTokens !== undefined) {
    total.totalTokens = (current.totalTokens ?? 0) + (next.totalTokens ?? 0);
  }
  return total;
}

/**
 * Resolve a schema-constrained turn.
 *
 * The final assistant text is the carrier, so this reads whatever the turn
 * actually produced rather than the run's summary field alone — a turn that
 * streamed its JSON and reported no result string is still a valid answer.
 */
function recordStructuredOutput(
  state: SessionState,
  finalText: string | undefined,
  input: DispatchInput,
): void {
  const { schema, requestId } = input;
  if (!schema || !requestId) {
    state.currentTurnOutput = null;
    return;
  }
  const output = (state.currentTurnOutput?.trim() || finalText?.trim()) ?? "";
  state.currentTurnOutput = null;

  if (Buffer.byteLength(output) > MAX_STRUCTURED_RESULT_BYTES) {
    setStructuredResult(state, requestId, {
      ok: false,
      provider: PROVIDER,
      requestId,
      error: { code: "output_too_large", message: "Structured output exceeded the size limit" },
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
          error: { code: "invalid_output", message: "The turn did not end with a JSON value" },
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
 * A cancelled or superseded turn can keep emitting for a while: its run object
 * outlives the request that abandoned it. Writing those frames into the
 * transcript would interleave a dead turn's output with the live one's.
 */
function turnStillOwned(state: SessionState, promptSequence: number): boolean {
  return state.promptSequence === promptSequence && state.status === "running";
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The Cursor turn failed";
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TurnTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
