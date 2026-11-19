/**
 * Editing a queued prompt in place (`begin_prompt_queue_message_edit`,
 * `renew_prompt_queue_message_edit`, `finish_prompt_queue_message_edit`).
 *
 * An edit holds a backend-issued lease on one queued item. While any lease
 * names an item, the backend will not deliver it: the dispatch reservation
 * and steer reservation both refuse it, and an item at the head blocks the
 * items behind it rather than being skipped, so the queue's order never
 * changes because someone is typing. The item keeps its id, its position and
 * its settings; only its text and attachments change, together, when the
 * edit is committed.
 *
 * A lease the editing client stops renewing expires into review: it still
 * holds the item, because a half-edited prompt must not be sent in its old
 * form, and a client resolves it by taking the edit over (then saving or
 * cancelling). An expired lease is never released silently.
 *
 * Browser-safe.
 */

/** How long a lease lasts without a renewal. */
export const PROMPT_QUEUE_EDIT_LEASE_MS = 60_000;

/** How often an editing client renews its lease: three renewals per lease. */
export const PROMPT_QUEUE_EDIT_RENEW_MS = 20_000;

/** The most leases one queue keeps; a queue is a handful of prompts. */
export const MAX_PROMPT_QUEUE_EDIT_LEASES = 64;

/** One edit lease as the queue stores it. */
export interface PromptQueueEditLease {
  messageId: string;
  /** Backend-issued; a commit or renewal must present it. */
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
  /** SHA-256 of the item when the edit began; a commit refuses if it changed since. */
  baseFingerprint: string;
}

/** A lease as a session projection shows it: no fingerprint. */
export interface PromptQueueEditView {
  messageId: string;
  leaseId: string;
  expiresAt: string;
}

/** Why an edit could not begin. */
export type PromptQueueEditBeginRefusal =
  /** The item is not queued: removed, or already sent. */
  | "missing"
  /** A backend-authored item (an annotation request, a goal turn): never edited. */
  | "frozen"
  /** Another client holds a lease that has not expired; `takeOver` overrides it. */
  | "held-elsewhere";

/** Why a renewal or a commit no longer applies. */
export type PromptQueueEditConflict =
  /** Another client took the edit over, or it was cancelled. */
  | "lease-lost"
  /** The item left the queue: removed by another client, or the queue is gone. */
  | "missing"
  /** The item's content changed since this edit began. */
  | "changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Whether `value` is a well-formed stored lease. */
export function isPromptQueueEditLease(value: unknown): value is PromptQueueEditLease {
  return (
    isRecord(value) &&
    isNonBlank(value.messageId) &&
    isNonBlank(value.leaseId) &&
    isTimestamp(value.acquiredAt) &&
    isTimestamp(value.expiresAt) &&
    typeof value.baseFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.baseFingerprint)
  );
}

/**
 * A queue's well-formed leases, at most one per item (the first wins). A
 * malformed entry is ignored: only the backend writes them.
 */
export function promptQueueEditLeases(queue: unknown): PromptQueueEditLease[] {
  if (!isRecord(queue) || !Array.isArray(queue.editLeases)) return [];
  const seen = new Set<string>();
  const leases: PromptQueueEditLease[] = [];
  for (const candidate of queue.editLeases) {
    if (!isPromptQueueEditLease(candidate) || seen.has(candidate.messageId)) continue;
    seen.add(candidate.messageId);
    leases.push(candidate);
  }
  return leases;
}

/** The lease on `messageId`, if any. */
export function promptQueueEditLease(
  queue: unknown,
  messageId: string,
): PromptQueueEditLease | undefined {
  return promptQueueEditLeases(queue).find((lease) => lease.messageId === messageId);
}

/**
 * Whether delivery must leave the queue's head alone: someone is editing it.
 * The items behind it wait too, so the order never changes.
 */
export function promptQueueHeadHeldByEdit(queue: unknown): boolean {
  if (!isRecord(queue) || !Array.isArray(queue.messages)) return false;
  const head: unknown = queue.messages[0];
  return isRecord(head) && isNonBlank(head.id)
    ? promptQueueEditLease(queue, head.id) !== undefined
    : false;
}

/** Whether the lease's holder has stopped renewing it, so it awaits review. */
export function promptQueueEditLeaseExpired(
  lease: Pick<PromptQueueEditLease, "expiresAt">,
  now = Date.now(),
): boolean {
  return Date.parse(lease.expiresAt) <= now;
}

/** The projection view of a queue's leases. */
export function promptQueueEditViews(queue: unknown): PromptQueueEditView[] {
  return promptQueueEditLeases(queue).map(({ messageId, leaseId, expiresAt }) => ({
    messageId,
    leaseId,
    expiresAt,
  }));
}
