/**
 * When and how the bridge retries a turn the model refused for capacity.
 *
 * Codex ends such a turn with `turn/completed` `status: "failed"` and
 * `codexErrorInfo: "serverOverloaded"` (`CodexErr::ServerOverloaded`, shown as
 * "Selected model is at capacity. Please try a different model."). app-server
 * does not retry it itself: its own retry loop covers stream disconnects and
 * 5xx responses (`willRetry` on the standalone `error` notification), never
 * this. Unattended work (Multi Review steps, build stages) fails on the first
 * status read that says `error`, so the bridge continues the turn itself, with
 * exponential backoff, while it keeps reporting the session `running`.
 *
 * Pure: no timers, no I/O. `app-server-runtime-capacity-retry.ts` drives it.
 */
import type { EngineError } from "../engine/types.js";

export interface CapacityRetryPolicy {
  /** Attempts in total, the original one included. 1 turns retrying off. */
  maxAttempts: number;
  /** Nominal wait before the first retry. */
  baseDelayMs: number;
  /** Growth of the nominal wait per retry. */
  multiplier: number;
  /** Ceiling on any one wait, applied before jitter. */
  maxDelayMs: number;
}

/**
 * Five attempts, waits of about 2, 6, 18 and 54 s: about 80 s in all, never
 * more than 60 s at once. A capacity incident usually needs longer than a
 * doubling series from 2 s gives it (about 30 s for four retries), and a
 * workflow abandons a step only after 45 minutes without activity, so the
 * longer window costs nothing a user waits on in practice.
 */
export const DEFAULT_CAPACITY_RETRY_POLICY: CapacityRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  multiplier: 3,
  maxDelayMs: 60_000,
};

/** `CodexErr::ServerOverloaded`'s text, verbatim, as app-server reports it. */
export const CODEX_SERVER_OVERLOADED_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

/**
 * True only for a model capacity refusal.
 *
 * The structured `serverOverloaded` code decides. The exact message is
 * accepted only when app-server sent no code at all, so a build that drops the
 * code still retries, and no other text ever does. Usage limits, rate limits,
 * quota, login refusals and bad requests all carry their own codes and are
 * never retried; a 401/403 is refused even under the overload code.
 */
export function isModelCapacityError(error: EngineError | undefined): boolean {
  if (!error) return false;
  if (error.httpStatusCode === 401 || error.httpStatusCode === 403) return false;
  if (error.code !== undefined) return error.code === "serverOverloaded";
  return error.message.trim() === CODEX_SERVER_OVERLOADED_MESSAGE;
}

/**
 * The wait before attempt `nextAttempt` (2 for the first retry).
 *
 * "Equal jitter": half the nominal wait is fixed, the other half random, so
 * retries from many sessions refused at the same moment spread out, and none
 * retries sooner than half its nominal wait.
 */
export function capacityRetryDelayMs(
  policy: CapacityRetryPolicy,
  nextAttempt: number,
  random: () => number = Math.random,
): number {
  const retryIndex = Math.max(0, nextAttempt - 2);
  const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** retryIndex);
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(nominal / 2 + (nominal / 2) * unit);
}

/** Whole seconds for the transcript; a sub-second wait still reads "1 s". */
export function formatRetryDelay(delayMs: number): string {
  return `${Math.max(1, Math.round(delayMs / 1_000))} s`;
}

/** The pending card's text while the bridge waits. */
export function capacityRetryWaitingText(
  delayMs: number,
  nextAttempt: number,
  maxAttempts: number,
): string {
  return `Model at capacity, retrying in ${formatRetryDelay(delayMs)} (attempt ${nextAttempt} of ${maxAttempts})`;
}

/** The card once the continuation was accepted. */
export function capacityRetryStartedText(nextAttempt: number, maxAttempts: number): string {
  return `Model at capacity, retried automatically (attempt ${nextAttempt} of ${maxAttempts})`;
}

/** The card when Stop, a close or a restart ended the wait. */
export const CAPACITY_RETRY_CANCELLED_TEXT = "Model at capacity, automatic retry cancelled";

/** The card when the continuation could not be started. */
export const CAPACITY_RETRY_START_FAILED_TEXT =
  "Model at capacity, automatic retry could not be started";

/**
 * The error a turn ends with once retrying stops: the provider's own error,
 * as before, saying retries ran out. The code is kept, so callers still see a
 * capacity failure.
 */
export function capacityRetriesExhaustedError(error: EngineError, attempts: number): EngineError {
  return {
    ...error,
    message: `${error.message} Automatic retries exhausted after ${attempts} attempts.`,
  };
}

/** Id of the card for one retry, unique within the turn. */
export function capacityRetryItemId(requestId: string, nextAttempt: number): string {
  return `capacity-retry:${requestId}:${nextAttempt}`;
}

/**
 * `clientUserMessageId` of a continuation. Never the original request id:
 * `reconcileFromThreadTurns` takes the first turn carrying an id, which would
 * be the failed attempt.
 */
export function capacityRetryClientId(requestId: string, nextAttempt: number): string {
  return `${requestId}:capacity-retry:${nextAttempt}`;
}

/**
 * Opens every continuation the bridge sends. The rollout keeps it as a user
 * message; replay recognises it by this exact prefix and shows a retry card,
 * never a message the user typed.
 */
export const CAPACITY_RETRY_CONTINUATION_MARKER = "[Orkestrator automatic retry]";

/** What the bridge sends in place of the user's prompt. */
export function capacityRetryContinuationText(nextAttempt: number, maxAttempts: number): string {
  return [
    `${CAPACITY_RETRY_CONTINUATION_MARKER} attempt ${nextAttempt} of ${maxAttempts}.`,
    "The previous attempt of this turn ended because the model was at capacity. This message was sent automatically, not by the user.",
    "Continue the original request from where it stopped. Do not repeat work or tool calls that already completed; check the conversation so far and finish the request.",
  ].join("\n");
}

/** The attempt a continuation's text names, or undefined if it is not one. */
export function parseCapacityRetryContinuation(
  text: string,
): { attempt: number; maxAttempts: number } | undefined {
  if (!text.startsWith(CAPACITY_RETRY_CONTINUATION_MARKER)) return undefined;
  const match = /^ attempt (\d+) of (\d+)\./.exec(
    text.slice(CAPACITY_RETRY_CONTINUATION_MARKER.length),
  );
  if (!match) return undefined;
  return { attempt: Number(match[1]), maxAttempts: Number(match[2]) };
}
