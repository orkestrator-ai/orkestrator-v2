/**
 * Fitting every session into one bounded state file.
 *
 * Each transcript is bounded on its own, but the state file holds all of them,
 * so enough ordinary sessions always eventually outgrow the whole-file limit.
 * Skipping the write there — which is what this bridge used to do — is silently
 * permanent: nothing shrinks the aggregate afterwards, so every later write is
 * skipped too, and a restart loses new sessions, composer choices and the
 * at-most-once journals along with the transcripts.
 *
 * What is shed instead is the one thing that is reconstructible: the persisted
 * copy of a rendered transcript, oldest-touched session first. Session
 * identity, the provider agent id, policy, composer, journals and structured
 * results are recovery state and are never shed. If they alone do not fit, the
 * snapshot is refused with a typed error so a caller that needed it published
 * cannot proceed as though it had been.
 *
 * Pure: builds a string from records it is handed and never touches a live
 * session, so the tab the user is watching keeps its transcript.
 */
import type { BridgeMessage, PersistedSession } from "./state.js";

/** A session's persisted record, minus the transcript that may be shed. */
export type EssentialRecord = Omit<PersistedSession, "messages">;

export interface BudgetedSession {
  id: string;
  /** Retention priority: the most recently touched transcripts are kept first. */
  lastAccessed: number;
  essential: EssentialRecord;
  messages: readonly BridgeMessage[];
}

export interface BudgetedSnapshot {
  serialized: string;
  bytes: number;
  /** Sessions whose transcript copy was left out of this snapshot. */
  shed: string[];
}

export type PersistenceErrorCode =
  | "persistence-failed"
  | "persistence-budget-exceeded"
  | "persistence-closed";

/**
 * A mandatory publication did not happen.
 *
 * The message is fixed text: a filesystem error carries paths, and this is
 * returned to HTTP callers and recorded as a runtime notice.
 */
export class PersistenceError extends Error {
  override readonly name = "PersistenceError";
  /**
   * For a budget refusal: the sessions whose essential records are largest,
   * so the notice can name where the space went. Ids only, never content.
   */
  readonly sessionIds: readonly string[];

  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    options?: { cause?: unknown; sessionIds?: readonly string[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.sessionIds = options?.sessionIds ?? [];
  }
}

/** Sessions a budget refusal names at most. */
export const MAX_BUDGET_OFFENDERS = 8;

/**
 * Serialize `sessions` under `budget` bytes, shedding transcripts as needed.
 *
 * Every session is first charged at its minimal size — the essential record
 * with an empty transcript — which is also the admission check. Records are
 * encoded one at a time against a running total, and the first one that takes
 * it over the budget stops the pass: a refused attempt holds at most the budget
 * plus that one record, never every session's encoding. It throws a
 * `persistence-budget-exceeded` error naming the largest records measured, and
 * nothing is published.
 *
 * Transcripts are then added newest-touched first until the next one would not
 * fit; that one and every older one are shed. This is exactly "drop the oldest
 * until it fits", computed without re-serializing the aggregate once per
 * dropped session.
 *
 * Scratch memory on success, honestly: the retained records (at most the
 * budget), plus one transcript's encoding and the record built around it while
 * that transcript is being considered (about twice the largest transcript),
 * plus the final joined string (at most the budget). So roughly two budgets
 * plus two transcripts at the peak, all bounded; the essential objects handed
 * in are shallow projections of live state and are not re-copied here.
 */
export function serializeWithinBudget(
  envelope: Record<string, unknown>,
  sessions: readonly BudgetedSession[],
  budget: number,
): BudgetedSnapshot {
  const envelopeJson = JSON.stringify({ ...envelope, sessions: [] });
  // `...,"sessions":[]}` — the records are spliced between the brackets.
  const head = envelopeJson.slice(0, -2);
  const tail = "]}";
  const records: string[] = [];
  const recordBytes: number[] = [];
  let total = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (const [index, session] of sessions.entries()) {
    const record = recordJson(shedEssential(session), EMPTY_TRANSCRIPT);
    const bytes = Buffer.byteLength(record);
    records.push(record);
    recordBytes.push(bytes);
    total += bytes + (index > 0 ? 1 : 0);
    if (total > budget) {
      throw new PersistenceError(
        "persistence-budget-exceeded",
        "Cursor bridge session state is too large to save; close unused Cursor tabs to free space",
        { sessionIds: largestRecords(sessions, recordBytes, total - budget) },
      );
    }
  }

  const shed = new Set(sessions.filter((session) => session.messages.length > 0).map((s) => s.id));
  const byRecency = sessions
    .map((session, index) => ({ session, index }))
    .sort(
      (left, right) =>
        right.session.lastAccessed - left.session.lastAccessed ||
        (left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0),
    );
  for (const { session, index } of byRecency) {
    if (session.messages.length === 0) continue;
    const kept = recordJson(session.essential, JSON.stringify(session.messages));
    const delta = Buffer.byteLength(kept) - recordBytes[index]!;
    if (total + delta > budget) break;
    records[index] = kept;
    recordBytes[index] = recordBytes[index]! + delta;
    total += delta;
    shed.delete(session.id);
  }

  const serialized = `${head}${records.join(",")}${tail}`;
  const bytes = Buffer.byteLength(serialized);
  // The accounting above is exact by construction. Verify it anyway: a
  // mismatch would publish a file the next start refuses to read.
  if (bytes !== total || bytes > budget) {
    throw new PersistenceError(
      "persistence-budget-exceeded",
      "Cursor bridge could not size its session state; nothing was saved",
    );
  }
  return { serialized, bytes, shed: Array.from(shed) };
}

/**
 * The largest measured records whose removal alone would recover `overflow`
 * bytes, largest first and at most {@link MAX_BUDGET_OFFENDERS}. Only the
 * sessions measured before the pass stopped are candidates: they alone
 * already exceed the budget, so their largest records are where the space went.
 */
function largestRecords(
  sessions: readonly BudgetedSession[],
  recordBytes: readonly number[],
  overflow: number,
): string[] {
  const bySize = recordBytes
    .map((bytes, index) => ({ bytes, id: sessions[index]!.id }))
    .sort((left, right) => right.bytes - left.bytes || (left.id < right.id ? -1 : 1));
  const named: string[] = [];
  let recovered = 0;
  for (const { bytes, id } of bySize) {
    if (recovered >= overflow || named.length >= MAX_BUDGET_OFFENDERS) break;
    named.push(id);
    recovered += bytes;
  }
  return named;
}

const EMPTY_TRANSCRIPT = "[]";

/**
 * The record a shed session is published as.
 *
 * The absolute index is carried forward rather than reset, so a renderer
 * cursor from before the restart lands on an honest, empty retained window
 * instead of being matched against a different message at the same index.
 * The revision moves too: a client holding the old revision must not read an
 * unchanged number as an unchanged transcript.
 */
function shedEssential(session: BudgetedSession): EssentialRecord {
  if (session.messages.length === 0) return session.essential;
  return {
    ...session.essential,
    droppedMessages: (session.essential.droppedMessages ?? 0) + session.messages.length,
    droppedParts:
      (session.essential.droppedParts ?? 0) +
      session.messages.reduce((sum, message) => sum + message.parts.length, 0),
    transcriptTruncated: true,
    revision: session.essential.revision + 1,
  };
}

/**
 * One session record with the transcript spliced in as the final property.
 *
 * `messages` is serialized separately so its bytes can be measured once and
 * reused, rather than serialized again inside the record.
 */
function recordJson(essential: EssentialRecord, messagesJson: string): string {
  const withPlaceholder = JSON.stringify({ ...essential, messages: [] });
  return `${withPlaceholder.slice(0, -EMPTY_PLACEHOLDER.length)}${messagesJson}}`;
}

const EMPTY_PLACEHOLDER = "[]}";
