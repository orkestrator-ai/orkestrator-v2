/**
 * Running one turn.
 *
 * The turn is where at-most-once matters. A prompt whose acknowledgement is
 * lost must never be re-sent on a guess, so this module keeps a durable
 * journal of every request id it has taken and refuses to reuse one whose
 * outcome a previous bridge process could not record.
 */
import { tryParseStructuredOutputText } from "@orkestrator/protocol/structured-output";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  MAX_PROMPT_JOURNAL,
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  PROMPT_TIMEOUT_MS,
  PROVIDER,
} from "./config.js";
import { denyAllApprovals } from "./interactions.js";
import { schedulePersist } from "./persistence.js";
import { boundTranscript } from "./transcript.js";
import { withTimeout } from "./timeout.js";
import {
  setSteerJournal,
  type JsonObject,
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
): Promise<DispatchHandle> {
  const text = input.schema
    ? `${input.prompt}\n\n${structuredPromptInstruction(input.schema)}`
    : input.prompt;
  const promptSequence = state.promptSequence;

  let announceAccepted: (accepted: boolean) => void = () => undefined;
  const accepted = new Promise<boolean>((resolve) => {
    announceAccepted = resolve;
  });

  const run = session.prompt(text, {
    ...(input.images.length > 0 ? { images: input.images.map(toImageContent) } : {}),
    // Prompt templates and skills are the user's own text, expanded by Pi. Left
    // on so a `/command` typed in the composer behaves exactly as it does in a
    // Pi terminal tab.
    expandPromptTemplates: true,
    // Not "interactive": a person typed this, but there is no terminal behind
    // it, so an extension that would draw a dialog has to know it cannot.
    source: "rpc",
    preflightResult: (success) => announceAccepted(success),
  });

  // A rejection before preflight ran — no model, no credential — must not leave
  // the caller awaiting acceptance forever.
  const settled = run.then(
    () => announceAccepted(true),
    () => announceAccepted(false),
  );

  if (!(await accepted)) {
    // Pi refused the prompt outright. Surface whatever it refused with, rather
    // than a generic rejection: it is the only thing that says why.
    await settled;
    await run;
    throw new Error("Pi rejected the prompt");
  }

  state.cancelTurn = async () => {
    await session.abort().catch(() => undefined);
  };

  // Never rejects: every terminal path is recorded on the session, and an
  // unobserved rejection here would take the whole bridge down.
  return { completion: followRun(state, session, run, promptSequence, input) };
}

async function followRun(
  state: SessionState,
  session: AgentSession,
  run: Promise<void>,
  promptSequence: number,
  input: DispatchInput,
): Promise<void> {
  try {
    await withTimeout(run, PROMPT_TIMEOUT_MS, "The Pi turn exceeded its time budget");
    if (!turnStillOwned(state, promptSequence)) return;
    finishTurn(state, session, input);
  } catch (error) {
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
      await state.cancelTurn?.();
    } catch {
      // Best-effort. A session that will not abort still has to reach a
      // terminal state here, or the tab stays "running" forever.
    }
    if (!turnStillOwned(state, promptSequence)) return;
    failTurn(state, session, error, input);
  }
}

function finishTurn(state: SessionState, session: AgentSession, input: DispatchInput): void {
  settleTurn(state, session);
  // A cancelled turn is not an error: the user asked for it, and the partial
  // transcript is the honest record of what ran.
  state.status = "idle";
  state.error = undefined;
  recordUsage(state);
  recordStructuredOutput(state, input);
  journal(state, input.requestId, "completed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
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
  recordUsage(state);
  recordStructuredOutput(state, input);
  journal(state, input.requestId, "failed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
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
function recordUsage(state: SessionState): void {
  const turn = state.currentTurnUsage;
  const elapsed = state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined;
  const context = readContextUsage(state);
  if (turn && Object.keys(turn).length > 0) {
    state.usage = {
      turn,
      ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
      ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
      ...context,
      ...readCost(state),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentTurnUsage = undefined;
  state.turnStartedAt = undefined;
}

function readContextUsage(
  state: SessionState,
): { contextTokens?: number; contextWindow?: number } | undefined {
  try {
    const usage = state.session?.getContextUsage();
    if (!usage) return undefined;
    const record = usage as unknown as Record<string, unknown>;
    const tokens = record.totalTokens ?? record.tokens ?? record.used;
    const window = record.contextWindow ?? record.maxTokens;
    return {
      ...(typeof tokens === "number" && Number.isFinite(tokens) ? { contextTokens: tokens } : {}),
      ...(typeof window === "number" && Number.isFinite(window) ? { contextWindow: window } : {}),
    };
  } catch {
    // Context accounting is a display nicety. A session that cannot report it
    // must not fail the turn that just succeeded.
    return undefined;
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
function recordStructuredOutput(state: SessionState, input: DispatchInput): void {
  const { schema, requestId } = input;
  if (!schema || !requestId) {
    state.currentTurnOutput = null;
    return;
  }
  const output = state.currentTurnOutput?.trim() ?? "";
  state.currentTurnOutput = null;

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
