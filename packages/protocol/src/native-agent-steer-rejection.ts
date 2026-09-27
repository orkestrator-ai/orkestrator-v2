/**
 * Definitive steer refusal contract.
 *
 * A bridge whose steer history cannot safely admit another distinct
 * instruction answers `POST /session/:id/steer` with HTTP 429 and
 * `{ outcome: "rejected", reason, requestId, message }`. That is a positive
 * "this exact request was not sent" answer, so the backend may clear the
 * parked attempt instead of reconciling it. Anything weaker — a generic 429 or
 * 5xx, a malformed body, an unknown reason, or a body naming another request —
 * proves nothing and must keep the conservative handling.
 */

export const NATIVE_AGENT_STEER_REJECTION_HTTP_STATUS = 429;

/**
 * - `steer-capacity-exceeded`: the run's protected steer history is full.
 * - `steer-history-unavailable`: recovery could not establish which history is
 *   safe, so steering the recovered run is refused until it settles.
 * - `steer-not-recorded`: the bridge prepared the record but could not publish
 *   it, so it refused before any provider side effect.
 */
export const NATIVE_AGENT_STEER_REJECTION_REASONS = [
  "steer-capacity-exceeded",
  "steer-history-unavailable",
  "steer-not-recorded",
] as const;

export type NativeAgentSteerRejectionReason = (typeof NATIVE_AGENT_STEER_REJECTION_REASONS)[number];

/** User-facing text bound, in UTF-16 code units, shared by bridge and backend. */
export const MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS = 300;
/** Matches the backend's persisted steer request-id bound. */
const MAX_NATIVE_AGENT_STEER_REQUEST_ID_BYTES = 512;

/**
 * The provider refused this exact steer before delivery. `shareUrl`/`preview`
 * are declared absent so callers of other actions can read those fields off
 * the outcome union without narrowing first.
 */
export interface NativeAgentSteerRejectedOutcome {
  outcome: "rejected";
  reason: NativeAgentSteerRejectionReason;
  requestId: string;
  message?: string;
  shareUrl?: never;
  preview?: never;
}

export function isNativeAgentSteerRejectionReason(
  value: unknown,
): value is NativeAgentSteerRejectionReason {
  return (
    typeof value === "string" &&
    (NATIVE_AGENT_STEER_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Normalize untrusted refusal text for display: control characters become
 * spaces, whitespace collapses, and the result is cut at a code-point boundary
 * within the shared bound. Returns undefined when nothing displayable remains.
 */
export function boundNativeAgentSteerRejectionMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bound the work before normalizing an arbitrarily large string.
  const head = value.slice(0, MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS * 4);
  const normalized = head
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS) return normalized;
  let bounded = "";
  for (const char of normalized) {
    if (bounded.length + char.length > MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS - 1) break;
    bounded += char;
  }
  return `${bounded.trimEnd()}…`;
}

function isBoundedRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_NATIVE_AGENT_STEER_REQUEST_ID_BYTES
  );
}

/**
 * Accept a bridge steer response as a definitive refusal only when every part
 * of the contract matches: status 429, `outcome: "rejected"`, a known reason,
 * and the caller's own request id. Everything else returns undefined.
 */
export function parseNativeAgentSteerRejection(
  status: number,
  body: unknown,
  requestId: string,
): NativeAgentSteerRejectedOutcome | undefined {
  if (status !== NATIVE_AGENT_STEER_REJECTION_HTTP_STATUS) return undefined;
  if (!isBoundedRequestId(requestId)) return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (record.outcome !== "rejected") return undefined;
  if (!isNativeAgentSteerRejectionReason(record.reason)) return undefined;
  if (record.requestId !== requestId) return undefined;
  const message = boundNativeAgentSteerRejectionMessage(record.message);
  return {
    outcome: "rejected",
    reason: record.reason,
    requestId,
    ...(message ? { message } : {}),
  };
}

/**
 * Validate an already-normalized rejected outcome, optionally for one exact
 * request. Storage uses this so only a well-formed refusal naming the parked
 * steer can clear it.
 */
export function isNativeAgentSteerRejectedOutcome(
  value: unknown,
  requestId?: string,
): value is NativeAgentSteerRejectedOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.outcome !== "rejected") return false;
  if (!isNativeAgentSteerRejectionReason(record.reason)) return false;
  if (!isBoundedRequestId(record.requestId)) return false;
  if (requestId !== undefined && record.requestId !== requestId) return false;
  if (record.message !== undefined) {
    if (typeof record.message !== "string") return false;
    if (boundNativeAgentSteerRejectionMessage(record.message) !== record.message) return false;
  }
  return true;
}

/** Actionable text for a refused steer; the draft stays available to resend. */
export function nativeAgentSteerRejectionMessage(
  outcome: Pick<NativeAgentSteerRejectedOutcome, "reason" | "message">,
): string {
  if (outcome.message) return outcome.message;
  switch (outcome.reason) {
    case "steer-capacity-exceeded":
      return "This turn cannot accept more steering. Wait for it to finish, then send your message again.";
    case "steer-history-unavailable":
      return "Steering is unavailable for this turn. Wait for it to finish, then send your message again.";
    case "steer-not-recorded":
      return "Your message was not sent because it could not be recorded safely. Send it again.";
    default:
      return assertNeverSteerRejectionReason(outcome.reason);
  }
}

function assertNeverSteerRejectionReason(reason: never): never {
  throw new Error(`Unhandled steer rejection reason: ${String(reason)}`);
}

/**
 * Content-free steer-history occupancy a bridge reports in its runtime-health
 * summary (`summary.steer`). Counts and limits only: no request ids, digests
 * or steering text ever cross this boundary. `saturated` means a new distinct
 * steer would be refused (`steer-capacity-exceeded`) until the run settles.
 */
export interface NativeAgentRuntimeSteerJournal {
  entries: number;
  limitEntries: number;
  bytes: number;
  limitBytes: number;
  /** Runs whose older history was evicted and are fenced against replay. */
  fencedRuns: number;
  saturated: boolean;
}

/** Ceilings applied at every hop so a hostile body cannot inflate the panel. */
const MAX_STEER_JOURNAL_COUNT = 1_000_000;
const MAX_STEER_JOURNAL_BYTES = 1024 * 1024 * 1024;

function boundedCount(value: unknown, ceiling: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.min(value, ceiling);
}

/**
 * Validate an untrusted `steer` summary. Every field must be present and
 * well-typed; anything else is dropped whole rather than half-shown. Unknown
 * fields are never copied, so nothing beyond counts and limits survives.
 */
export function normalizeNativeAgentRuntimeSteerJournal(
  value: unknown,
): NativeAgentRuntimeSteerJournal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const entries = boundedCount(record.entries, MAX_STEER_JOURNAL_COUNT);
  const limitEntries = boundedCount(record.limitEntries, MAX_STEER_JOURNAL_COUNT);
  const bytes = boundedCount(record.bytes, MAX_STEER_JOURNAL_BYTES);
  const limitBytes = boundedCount(record.limitBytes, MAX_STEER_JOURNAL_BYTES);
  const fencedRuns = boundedCount(record.fencedRuns, MAX_STEER_JOURNAL_COUNT);
  if (
    entries === undefined ||
    limitEntries === undefined ||
    bytes === undefined ||
    limitBytes === undefined ||
    fencedRuns === undefined ||
    typeof record.saturated !== "boolean"
  ) {
    return undefined;
  }
  return { entries, limitEntries, bytes, limitBytes, fencedRuns, saturated: record.saturated };
}
