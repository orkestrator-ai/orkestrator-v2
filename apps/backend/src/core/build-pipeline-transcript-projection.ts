import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { PersistedBuildPipeline } from "./models.js";
import type { TranscriptRead } from "./build-pipeline-transcript-store.js";
import {
  LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES,
  committedTranscriptCursor,
  snapshotWithoutInlineTranscripts,
} from "./build-pipeline-transcripts.js";

/**
 * Transcript-aware projections for the build-pipeline read commands.
 *
 * Control records are returned without transcript bodies. A caller that wants
 * bodies names the revision/count it already holds per session and receives
 * only the referenced window each stale session needs, read straight from the
 * transcript store (or the legacy inline array of an unmigrated record).
 */

/**
 * Transcript bytes one conditional read may return. Matches the bound the
 * inline format put on a whole snapshot, so a response is never larger than
 * before the split; sessions past it are marked deferred and fetched by the
 * next read.
 */
export const BUILD_PIPELINE_PATCH_BUDGET_BYTES = LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES;

export interface BuildPipelineMessagePatch {
  sessionKey: string;
  baseRevision?: number;
  baseCount?: number;
  startIndex: number;
  revision: number;
  messages: unknown[];
  /** The stored transcript could not be read; the client keeps what it has. */
  unavailable?: true;
  /** Over this response's budget; the client asks again. */
  deferred?: true;
  /** Some history was not retained (see the session's transcript reference). */
  complete?: false;
}

export interface TranscriptReader {
  readBuildPipelineTranscript(
    pipelineId: string,
    session: Pick<PipelineSession, "sessionKey" | "transcript" | "messages" | "messageRevision">,
    window?: { fromIndex?: number; toIndex?: number },
  ): Promise<TranscriptRead>;
}

type Cursor = { revision: number; count: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCursor(value: unknown): value is Cursor {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    Number.isSafeInteger(value.count) &&
    (value.count as number) >= 0
  );
}

/** A record safe to return from any read: no inline transcript bodies. */
export function withoutTranscriptBodies(record: PersistedBuildPipeline): PersistedBuildPipeline {
  const snapshot = snapshotWithoutInlineTranscripts(record.snapshot);
  return snapshot === record.snapshot ? record : { ...record, snapshot };
}

function sessionNeedsPatch(session: PipelineSession, cursor: Cursor | undefined): boolean {
  const committed = committedTranscriptCursor(session);
  if (committed.revision === 0 && committed.count === 0) return false;
  return !cursor || cursor.revision !== committed.revision || cursor.count !== committed.count;
}

function validSessions(snapshot: unknown): PipelineSession[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return [];
  return (snapshot.sessions as unknown[]).filter(
    (session): session is PipelineSession =>
      isRecord(session) &&
      typeof session.sessionKey === "string" &&
      session.sessionKey.length > 0 &&
      (session.messageRevision === undefined || Number.isSafeInteger(session.messageRevision)),
  );
}

/**
 * Conditional point read: `unchanged` only when the control revision and every
 * session's transcript cursor match; otherwise the body-free record plus one
 * patch per stale session, newest-needed first and within the byte budget.
 */
export async function conditionalBuildPipelineRead(
  reader: TranscriptReader,
  record: PersistedBuildPipeline,
  input: {
    knownRevision?: unknown;
    knownSessions: Record<string, unknown>;
    prioritySessionKey?: unknown;
  },
  budgetBytes = BUILD_PIPELINE_PATCH_BUDGET_BYTES,
): Promise<
  | { unchanged: true; revision: number }
  | {
      unchanged: false;
      record: PersistedBuildPipeline;
      messagePatches: BuildPipelineMessagePatch[];
    }
> {
  const sessions = validSessions(record.snapshot);
  const cursorFor = (session: PipelineSession) => {
    const cursor = input.knownSessions[session.sessionKey];
    return isCursor(cursor) ? cursor : undefined;
  };
  const stale = sessions.filter((session) => sessionNeedsPatch(session, cursorFor(session)));
  if (
    Number.isSafeInteger(input.knownRevision) &&
    input.knownRevision === record.revision &&
    stale.length === 0
  ) {
    return { unchanged: true, revision: record.revision };
  }
  const currentIndex = isRecord(record.snapshot)
    ? (record.snapshot.currentSessionIndex as number)
    : -1;
  const currentKey = sessions[currentIndex]?.sessionKey;
  const rank = (session: PipelineSession): number => {
    if (session.sessionKey === input.prioritySessionKey) return 0;
    if (cursorFor(session)) return 1;
    if (session.sessionKey === currentKey) return 2;
    return 3;
  };
  const ordered = stale
    .map((session, index) => ({ session, index }))
    .sort((left, right) => rank(left.session) - rank(right.session) || right.index - left.index);
  const projectedRecord = withoutTranscriptBodies(record);
  let remaining =
    budgetBytes -
    Buffer.byteLength(
      JSON.stringify({ unchanged: false, record: projectedRecord, messagePatches: [] }),
      "utf8",
    );
  const messagePatches: BuildPipelineMessagePatch[] = [];
  const defer = (sessionKey: string, revision: number) => {
    const patch: BuildPipelineMessagePatch = {
      sessionKey,
      startIndex: 0,
      revision,
      messages: [],
      deferred: true,
    };
    const size =
      Buffer.byteLength(JSON.stringify(patch), "utf8") + (messagePatches.length > 0 ? 1 : 0);
    if (size <= remaining) {
      messagePatches.push(patch);
      remaining -= size;
    }
  };
  for (const { session } of ordered) {
    const committed = committedTranscriptCursor(session);
    const cursor = cursorFor(session);
    const mayHaveBase = cursor !== undefined && cursor.count > 0;
    if (remaining <= 0) {
      defer(session.sessionKey, committed.revision);
      continue;
    }
    // Overlap by one: the entry the client saw last may still have streamed.
    const tailStart = mayHaveBase ? cursor.count - 1 : 0;
    let read = await reader.readBuildPipelineTranscript(record.id, session, {
      fromIndex: tailStart,
      toIndex: tailStart + 1,
    });
    // An unrelated generation cannot use the client's tail. A continuation
    // of the same substituted generation can keep paging from that base.
    const exactBase =
      read.status === "found" &&
      mayHaveBase &&
      cursor.count <= read.messageCount &&
      (read.substituted
        ? cursor.revision === read.revision
        : cursor.revision <= committed.revision);
    if (read.status === "found" && !exactBase && tailStart > 0) {
      read = await reader.readBuildPipelineTranscript(record.id, session, {
        fromIndex: 0,
        toIndex: 1,
      });
    }
    if (read.status !== "found") {
      const unavailable: BuildPipelineMessagePatch = {
        sessionKey: session.sessionKey,
        startIndex: 0,
        revision: committed.revision,
        messages: [],
        unavailable: true,
      };
      const size =
        Buffer.byteLength(JSON.stringify(unavailable), "utf8") +
        (messagePatches.length > 0 ? 1 : 0);
      if (size <= remaining) {
        messagePatches.push(unavailable);
        remaining -= size;
      }
      continue;
    }
    const patch: BuildPipelineMessagePatch = {
      sessionKey: session.sessionKey,
      ...(exactBase ? { baseRevision: cursor!.revision, baseCount: cursor!.count } : {}),
      startIndex: read.startIndex,
      revision: read.substituted ? read.revision : committed.revision,
      messages: [],
      ...(read.complete ? {} : { complete: false as const }),
    };
    // Include the patch envelope and its comma in the response budget. Read
    // one message at a time so no stored 48 MiB body is materialized here.
    const patchOverhead =
      Buffer.byteLength(JSON.stringify(patch), "utf8") + (messagePatches.length > 0 ? 1 : 0);
    let allowance = remaining - patchOverhead;
    let nextIndex = read.startIndex;
    let candidate: TranscriptRead = read;
    while (candidate.status === "found" && nextIndex < candidate.messageCount) {
      const message = candidate.messages[0];
      if (message === undefined) break;
      const bytes =
        Buffer.byteLength(JSON.stringify(message) ?? "null", "utf8") +
        (patch.messages.length > 0 ? 1 : 0);
      if (bytes > allowance) break;
      patch.messages.push(message);
      allowance -= bytes;
      nextIndex += 1;
      if (nextIndex >= candidate.messageCount) break;
      candidate = await reader.readBuildPipelineTranscript(record.id, session, {
        fromIndex: nextIndex,
        toIndex: nextIndex + 1,
      });
      if (
        candidate.status !== "found" ||
        candidate.substituted !== read.substituted ||
        candidate.revision !== read.revision
      )
        break;
    }
    if (patch.messages.length === 0 && read.messageCount > read.startIndex) {
      defer(session.sessionKey, committed.revision);
      continue;
    }
    remaining = allowance;
    messagePatches.push(patch);
  }
  return {
    unchanged: false,
    record: projectedRecord,
    messagePatches,
  };
}
