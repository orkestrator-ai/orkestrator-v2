/**
 * Running one turn.
 *
 * The turn is where at-most-once matters. A prompt whose acknowledgement is
 * lost must never be re-sent on a guess, so this module keeps a durable
 * journal of every request id it has taken and refuses to reuse one whose
 * outcome a previous bridge process could not record.
 */
import { tryParseStructuredOutputText } from "@orkestrator/protocol/structured-output";
import type { SDKAgent, SDKImage } from "@cursor/sdk";
import {
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
import { type JsonObject, type PromptJournalEntry, type SessionState } from "./state.js";

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
  wait(): Promise<{
    status: string;
    result?: string;
    error?: { message: string };
    durationMs?: number;
  }>;
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
): Promise<void> {
  const drained = (async () => {
    try {
      for await (const _event of run.stream()) {
        // Intentionally empty: `onDelta` is the transcript source. Consuming
        // here only keeps a pull-driven stream advancing.
      }
    } catch {
      // A stream failure is reported authoritatively by `wait()` below.
    }
  })();

  try {
    const result = await withTimeout(run.wait(), timeoutMs);
    await drained;
    if (!turnStillOwned(state, promptSequence)) return;
    finishTurn(state, result, input);
  } catch (error) {
    // Giving up on the wait is not the same as the run stopping. Failing the
    // turn here clears `cancelTurn` and settles every background child, so a
    // run left alive would keep writing to the workspace while `/activity`
    // answers idle and the user has lost the only control that could stop it.
    //
    // Deliberately not awaited: the turn is over either way, and a `cancel`
    // that hangs must not pin the session as running — which is the state the
    // timeout exists to get it out of.
    if (error instanceof TurnTimeoutError) void run.cancel().catch(() => undefined);
    if (!turnStillOwned(state, promptSequence)) return;
    failTurn(state, error, input);
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
  result: { status: string; result?: string; error?: { message: string }; durationMs?: number },
  input: DispatchInput,
): void {
  settleBackgroundChildren(state);
  state.cancelTurn = undefined;
  state.pendingCancelPromptSequence = undefined;

  if (result.status === "error") {
    failTurn(state, new Error(result.error?.message ?? "The Cursor turn failed"), input);
    return;
  }

  // A cancelled turn is not an error: the user asked for it, and the partial
  // transcript is the honest record of what ran.
  state.status = "idle";
  state.error = undefined;
  recordUsage(state, result.durationMs);
  recordStructuredOutput(state, result.result, input);
  journal(state, input.requestId, "completed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

function failTurn(state: SessionState, error: unknown, input: DispatchInput): void {
  settleBackgroundChildren(state);
  state.cancelTurn = undefined;
  state.pendingCancelPromptSequence = undefined;
  state.status = "error";
  state.error = errorText(error);
  recordUsage(state, undefined);
  recordStructuredOutput(state, undefined, input);
  journal(state, input.requestId, "failed");
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

function recordUsage(state: SessionState, durationMs: number | undefined): void {
  const turn = state.currentTurnUsage;
  const elapsed =
    durationMs ?? (state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined);
  if (turn && Object.keys(turn).length > 0) {
    state.usage = {
      turn,
      ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
      ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentTurnUsage = undefined;
  state.turnStartedAt = undefined;
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
