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
 * What is shortened instead is the one thing that is only a display copy: the
 * persisted copy of a rendered transcript, oldest messages of the
 * oldest-touched sessions first. Session identity, the provider agent id,
 * policy, composer, journals and structured results are recovery state and are
 * never shed. If they alone do not fit, the snapshot is refused with a typed
 * error so a caller that needed it published cannot proceed as though it had
 * been.
 *
 * Pure: builds a string from records it is handed and never touches a live
 * session, so the tab the user is watching keeps its whole transcript.
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
  /**
   * Sessions whose persisted transcript copy is incomplete in this snapshot:
   * left out entirely, or cut to its newest messages.
   */
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

/** One session's record while its transcript tail is being chosen. */
interface PlannedRecord {
  session: BudgetedSession;
  essential: EssentialRecord;
  /** `{"id":…,` — every essential field except the truncation ones. */
  head: string;
  headBytes: number;
  /** Parts across the whole live transcript, for the dropped-parts count. */
  totalParts: number;
  /** Retained message encodings, newest first. */
  kept: string[];
  keptParts: number;
  /** Encoded bytes of `kept` joined with commas. */
  keptBytes: number;
  /** Encoded bytes of the whole record as currently planned. */
  bytes: number;
}

/**
 * Serialize `sessions` under `budget` bytes, shortening transcripts as needed.
 *
 * Every session is first charged at its minimal size — the essential record
 * with an empty transcript — which is also the admission check. Records are
 * encoded one at a time against a running total, and the first one that takes
 * it over the budget stops the pass: a refused attempt holds at most the budget
 * plus that one record, never every session's encoding. It throws a
 * `persistence-budget-exceeded` error naming the largest records measured, and
 * nothing is published.
 *
 * Transcripts are then added newest-touched session first (id breaks ties).
 * Within a session, messages are added newest first and whole while they fit
 * the bytes left; the first one that does not fit ends that session's tail and
 * every older message of it is left out. A session that does not fit whole so
 * keeps its newest bounded tail instead of nothing, and older-touched sessions
 * are still offered whatever room remains. This is "drop the oldest until it
 * fits", computed without re-serializing the aggregate per dropped message.
 *
 * Each essential record and each considered message is encoded exactly once.
 * The accounting is exact UTF-8 bytes, commas and brackets included: a record
 * is `head` + the truncation fields + `"messages":[` + tail + `]}`, and only
 * the few truncation fields depend on how many messages are kept.
 *
 * Scratch memory on success, honestly: the essential encodings and the kept
 * message encodings (together at most the budget), plus at most one encoded
 * message per session that turned out not to fit (released immediately), plus
 * the final joined string (at most the budget). The essential objects handed
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
  const planned: PlannedRecord[] = [];
  const recordBytes: number[] = [];
  let total = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (const [index, session] of sessions.entries()) {
    const record = planRecord(session);
    planned.push(record);
    recordBytes.push(record.bytes);
    total += record.bytes + (index > 0 ? 1 : 0);
    if (total > budget) {
      throw new PersistenceError(
        "persistence-budget-exceeded",
        "Cursor bridge session state is too large to save; close unused Cursor tabs to free space",
        { sessionIds: largestRecords(sessions, recordBytes, total - budget) },
      );
    }
  }

  const byRecency = planned
    .slice()
    .sort(
      (left, right) =>
        right.session.lastAccessed - left.session.lastAccessed ||
        (left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0),
    );
  for (const record of byRecency) {
    const messages = record.session.messages;
    // Newest first, whole messages only, stopping at the first that does not
    // fit: what is kept is always a contiguous tail.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const encoded = JSON.stringify(message);
      const keptBytes =
        record.keptBytes + Buffer.byteLength(encoded) + (record.kept.length > 0 ? 1 : 0);
      const keptParts = record.keptParts + message.parts.length;
      const bytes = recordSize(record, record.kept.length + 1, keptParts, keptBytes);
      if (total + bytes - record.bytes > budget) break;
      total += bytes - record.bytes;
      record.kept.push(encoded);
      record.keptParts = keptParts;
      record.keptBytes = keptBytes;
      record.bytes = bytes;
    }
  }

  const shed: string[] = [];
  const records = planned.map((record) => {
    const count = record.session.messages.length;
    if (record.kept.length < count) shed.push(record.session.id);
    // `kept` is newest first; the file holds messages oldest first.
    const transcript = record.kept.reverse().join(",");
    return `${record.head}${truncationFields(record, count - record.kept.length, record.keptParts)}${transcript}]}`;
  });
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
  return { serialized, bytes, shed };
}

/**
 * Encode a session's essential record once and charge it at its minimal size:
 * no messages kept.
 */
function planRecord(session: BudgetedSession): PlannedRecord {
  // Read once: the record is a projection of live state and is not re-read
  // after admission.
  const essential = session.essential;
  const {
    droppedMessages: _droppedMessages,
    droppedParts: _droppedParts,
    transcriptTruncated: _transcriptTruncated,
    revision: _revision,
    ...rest
  } = essential;
  const restJson = JSON.stringify(rest);
  const head = restJson === "{}" ? "{" : `${restJson.slice(0, -1)},`;
  let totalParts = 0;
  for (const message of session.messages) totalParts += message.parts.length;
  const record: PlannedRecord = {
    session,
    essential,
    head,
    headBytes: Buffer.byteLength(head),
    totalParts,
    kept: [],
    keptParts: 0,
    keptBytes: 0,
    bytes: 0,
  };
  record.bytes = recordSize(record, 0, 0, 0);
  return record;
}

function recordSize(
  record: PlannedRecord,
  keptCount: number,
  keptParts: number,
  keptBytes: number,
): number {
  const dropped = record.session.messages.length - keptCount;
  return (
    record.headBytes +
    Buffer.byteLength(truncationFields(record, dropped, keptParts)) +
    keptBytes +
    RECORD_CLOSE.length
  );
}

const RECORD_CLOSE = "]}";

/**
 * The fields that describe what the persisted copy left out, then the opening
 * of its `messages` array.
 *
 * A complete copy keeps the live values. An incomplete one advances the
 * absolute base by what it dropped, rather than resetting it, so a renderer
 * cursor from before the restart lands on an honest, shorter retained window
 * instead of being matched against a different message at the same index.
 * The revision moves too: a client holding the old revision must not read an
 * unchanged number as an unchanged transcript.
 */
function truncationFields(
  record: PlannedRecord,
  droppedMessages: number,
  keptParts: number,
): string {
  const essential = record.essential;
  const complete = droppedMessages === 0;
  const fields = {
    droppedMessages: (essential.droppedMessages ?? 0) + droppedMessages,
    droppedParts: (essential.droppedParts ?? 0) + (record.totalParts - keptParts),
    transcriptTruncated: complete ? (essential.transcriptTruncated ?? false) : true,
    revision: complete ? essential.revision : essential.revision + 1,
  };
  // Four scalars: cheap to encode per candidate, and encoded by the same
  // serializer as the rest of the record so the byte count cannot drift.
  return `${JSON.stringify(fields).slice(1, -1)},"messages":[`;
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
