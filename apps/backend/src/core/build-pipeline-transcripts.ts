import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { TranscriptRead } from "./build-pipeline-transcript-store.js";

/**
 * Shared helpers for build-pipeline transcripts that live outside the
 * workflow control record (plan step 16). Pure functions only; the store is
 * `build-pipeline-transcript-store.ts`, storage wiring is
 * `storage-build-pipelines.ts`, and the supervisor's checkpointing is
 * `build-pipeline-transcript-checkpoints.ts`.
 */

/** The bound the old inline format enforced on a whole pipeline snapshot. */
export const LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Newest request identity in a provider transcript.
 *
 * Only a legacy session that predates the persisted `structuredRequestId`
 * needs this; the migration stores its answer as `legacyStructuredRequestId`
 * so recovery never reads transcript bodies again.
 */
export function structuredRequestIdFromMessages(
  messages: readonly unknown[] | undefined,
): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const info =
      record.info && typeof record.info === "object"
        ? (record.info as Record<string, unknown>)
        : record;
    if (info.role === "user" && typeof info.id === "string") return info.id;
    if (typeof record.requestId === "string") return record.requestId;
    if (typeof record.id === "string" && record.role === "user") return record.id;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when a stored snapshot still carries any inline transcript array. */
export function hasInlineTranscript(snapshot: unknown): boolean {
  return (
    isRecord(snapshot) &&
    Array.isArray(snapshot.sessions) &&
    snapshot.sessions.some((session) => isRecord(session) && Array.isArray(session.messages))
  );
}

/** Copy of a session without its inline body, for responses that must not carry transcripts. */
export function withoutInlineTranscript<T>(session: T): T {
  if (!isRecord(session) || !("messages" in session)) return session;
  const { messages: _messages, ...rest } = session;
  return rest as T;
}

/** Copy of a stored snapshot whose sessions carry no inline bodies. */
export function snapshotWithoutInlineTranscripts(snapshot: unknown): unknown {
  if (!hasInlineTranscript(snapshot)) return snapshot;
  const record = snapshot as Record<string, unknown>;
  return {
    ...record,
    sessions: (record.sessions as unknown[]).map(withoutInlineTranscript),
  };
}

/**
 * Read adapter for a session that has not been migrated: serves the inline
 * array exactly like a stored transcript window, so callers need one path.
 */
export function readInlineTranscript(
  session: Pick<PipelineSession, "messages" | "messageRevision">,
  window: { fromIndex?: number; toIndex?: number } = {},
): Extract<TranscriptRead, { status: "found" }> {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const fromIndex = Math.max(0, Math.min(window.fromIndex ?? 0, messages.length));
  const toIndex = Math.max(fromIndex, Math.min(window.toIndex ?? messages.length, messages.length));
  return {
    status: "found",
    messages: messages.slice(fromIndex, toIndex),
    startIndex: fromIndex,
    messageCount: messages.length,
    revision: session.messageRevision ?? 0,
    complete: true,
    substituted: false,
  };
}

/** Committed display revision and retained count of a session's transcript. */
export function committedTranscriptCursor(session: PipelineSession): {
  revision: number;
  count: number;
} {
  if (session.transcript) {
    return { revision: session.messageRevision ?? 0, count: session.transcript.messageCount };
  }
  return {
    revision: session.messageRevision ?? 0,
    count: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}
