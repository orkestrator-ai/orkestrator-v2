/**
 * The query shapes rollout consumers are allowed to ask.
 *
 * No consumer receives a whole rollout as one array. Each asks the narrowest
 * question that preserves its existing result:
 *
 * | Consumer | Needs | Query |
 * | --- | --- | --- |
 * | Session catalogue (`getSessionMetaFromTranscriptPath`) | `session_meta` + first user message | `readTranscriptHead` — 64 KiB head, uncached, never indexed |
 * | Live sub-agent cards, parent rollout (`deriveTranscriptSubagentPartsForTurn`) | records at/after the turn start + first `session_meta` (agent path) | `readTurnRecords` → `readTranscriptSince` |
 * | Live and persisted sub-agent cards, child rollout | a reduction over the child's **whole** history (reusable threads reopen) | `readChildSummary` → `foldTranscript` (incremental, memoised) |
 * | Thread hydration on attach (`hydrateMessagesFromPersistedSession`) | a complete chronological replay | `acquireTranscriptSnapshot` + `forEachTranscriptBatch`; collaboration records are kept via `createCollaborationRecordFilter` |
 *
 * Every result carries a `TranscriptReadStatus`, so "could not be read" is never
 * reported as "has no records".
 */
import { foldTranscript, readTranscriptSince, type TranscriptReducer } from "./transcript-cache.js";
import {
  childTranscriptSummary,
  createChildTranscriptFoldState,
  estimateChildTranscriptFoldBytes,
  foldChildTranscriptRecord,
  summarizeChildTranscriptRecords,
  type ChildTranscriptFoldState,
  type ChildTranscriptSummary,
  type TranscriptReadStatus,
  type TranscriptRecord,
} from "./subagent-transcript.js";

export interface TurnRecordsResult {
  /** Records with a valid timestamp at or after the turn start, in file order. */
  records: readonly TranscriptRecord[];
  /** The rollout's first `session_meta`, wherever it sits. */
  sessionMeta?: TranscriptRecord;
  status: TranscriptReadStatus;
}

export interface TranscriptQueries {
  readTurnRecords(path: string, sinceMs: number): Promise<TurnRecordsResult>;
  readChildSummary(path: string): Promise<ChildTranscriptSummary>;
}

/** A rollout already held in memory — fixtures and injected test loaders. */
export interface TranscriptLike {
  records: readonly TranscriptRecord[];
}

const CHILD_TRANSCRIPT_REDUCER: TranscriptReducer<
  ChildTranscriptFoldState,
  ChildTranscriptSummary
> = {
  key: "child-transcript-summary",
  init: createChildTranscriptFoldState,
  step: foldChildTranscriptRecord,
  result: childTranscriptSummary,
  estimateBytes: estimateChildTranscriptFoldBytes,
};

export function readCachedChildTranscriptSummary(path: string): Promise<ChildTranscriptSummary> {
  return foldTranscript(path, CHILD_TRANSCRIPT_REDUCER);
}

/** Production queries, backed by the bounded rollout cache. */
export const cachedTranscriptQueries: TranscriptQueries = {
  readTurnRecords: readTranscriptSince,
  readChildSummary: readCachedChildTranscriptSummary,
};

function recordTimestampMs(record: TranscriptRecord): number {
  return record.timestamp ? new Date(record.timestamp).getTime() : Number.NaN;
}

/**
 * The same queries answered from fully materialised records. Semantically the
 * reference the cache must match: `readTurnRecords` is a timestamp filter and
 * `readChildSummary` a fold over every record.
 */
export function transcriptQueriesFromLoader(
  load: (path: string) => Promise<TranscriptLike>,
): TranscriptQueries {
  return {
    async readTurnRecords(path, sinceMs) {
      const { records } = await load(path);
      return {
        records: records.filter((record) => recordTimestampMs(record) >= sinceMs),
        sessionMeta: records.find((record) => record.type === "session_meta"),
        status: "complete",
      };
    },
    async readChildSummary(path) {
      return summarizeChildTranscriptRecords((await load(path)).records);
    },
  };
}
