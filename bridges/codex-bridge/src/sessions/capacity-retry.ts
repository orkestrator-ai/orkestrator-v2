/**
 * When and how the bridge retries a turn the model refused for capacity.
 *
 * Codex ends such a turn with `turn/completed` `status: "failed"` and
 * `codexErrorInfo: "serverOverloaded"` (`CodexErr::ServerOverloaded`, shown as
 * "Selected model is at capacity. Please try a different model.") or
 * `"policyCapacityUnavailable"`. app-server retries either itself only when the
 * server sends `Retry-After` (`willRetry` on the standalone `error`
 * notification); otherwise the turn fails. Unattended work (Multi Review steps, build stages) fails on the first
 * status read that says `error`, so the bridge continues the turn itself, with
 * exponential backoff, while it keeps reporting the session `running`.
 *
 * Pure: no timers, no I/O. `app-server-runtime-capacity-retry.ts` drives it. The
 * backoff itself is shared with the other providers
 * (`@orkestrator/protocol/capacity-retry`).
 */
import { formatRetryDelay } from "@orkestrator/protocol/capacity-retry";

import type { EngineError } from "../engine/types.js";

export {
  DEFAULT_CAPACITY_RETRY_POLICY,
  capacityRetryDelayMs,
  formatRetryDelay,
  type CapacityRetryPolicy,
} from "@orkestrator/protocol/capacity-retry";

/** `CodexErr::ServerOverloaded`'s text, verbatim, as app-server reports it. */
export const CODEX_SERVER_OVERLOADED_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

/** `CodexErrorDetails::PolicyCapacityUnavailable`'s text, verbatim (0.166). */
export const CODEX_POLICY_CAPACITY_UNAVAILABLE_MESSAGE =
  "Policy-restricted capacity is unavailable. Please try again later.";

/**
 * The two capacity refusals. `policyCapacityUnavailable` is a 503
 * `policy_capacity_unavailable`: the same condition for capacity reserved under
 * a policy, which Codex itself gives "the same retry advice as ordinary
 * overloads" and retries only when the server sends `Retry-After`.
 */
const CAPACITY_CODES = new Set(["serverOverloaded", "policyCapacityUnavailable"]);
const CAPACITY_MESSAGES = new Set([
  CODEX_SERVER_OVERLOADED_MESSAGE,
  CODEX_POLICY_CAPACITY_UNAVAILABLE_MESSAGE,
]);

/**
 * True only for a model capacity refusal.
 *
 * The structured code decides. The exact message is accepted only when
 * app-server sent no code at all, so a build that drops the code still
 * retries, and no other text ever does. Usage limits, rate limits, quota, login
 * refusals and bad requests all carry their own codes and are never retried; a
 * 401/403 is refused even under a capacity code.
 */
export function isModelCapacityError(error: EngineError | undefined): boolean {
  if (!error) return false;
  if (error.httpStatusCode === 401 || error.httpStatusCode === 403) return false;
  if (error.code !== undefined) return CAPACITY_CODES.has(error.code);
  return CAPACITY_MESSAGES.has(error.message.trim());
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
