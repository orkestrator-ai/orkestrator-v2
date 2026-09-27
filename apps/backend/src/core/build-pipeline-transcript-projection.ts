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
  let remaining = budgetBytes;
  const messagePatches: BuildPipelineMessagePatch[] = [];
  for (const { session } of ordered) {
    const committed = committedTranscriptCursor(session);
    const cursor = cursorFor(session);
    const usableBase =
      cursor !== undefined &&
      cursor.revision < committed.revision &&
      cursor.count <= committed.count;
    if (remaining <= 0) {
      messagePatches.push({
        sessionKey: session.sessionKey,
        startIndex: 0,
        revision: committed.revision,
        messages: [],
        deferred: true,
      });
      continue;
    }
    // Overlap by one: the entry the client saw last may still have streamed.
    const tailStart = usableBase ? Math.max(0, cursor.count - 1) : 0;
    let read = await reader.readBuildPipelineTranscript(record.id, session, {
      fromIndex: tailStart,
    });
    // A substituted generation is not the revision the client's base came
    // from: send it whole instead of as a tail.
    if (read.status === "found" && read.substituted && tailStart > 0) {
      read = await reader.readBuildPipelineTranscript(record.id, session, { fromIndex: 0 });
    }
    if (read.status !== "found") {
      messagePatches.push({
        sessionKey: session.sessionKey,
        startIndex: 0,
        revision: committed.revision,
        messages: [],
        unavailable: true,
      });
      continue;
    }
    remaining -= Buffer.byteLength(JSON.stringify(read.messages), "utf8");
    const exactBase = usableBase && !read.substituted;
    messagePatches.push({
      sessionKey: session.sessionKey,
      ...(exactBase ? { baseRevision: cursor.revision, baseCount: cursor.count } : {}),
      startIndex: read.startIndex,
      revision: read.substituted ? read.revision : committed.revision,
      messages: read.messages,
      ...(read.complete ? {} : { complete: false as const }),
    });
  }
  return {
    unchanged: false,
    record: withoutTranscriptBodies(record),
    messagePatches,
  };
}
