import { acpContextUsage } from "./usage.js";
import {
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  MAX_PROMPT_JOURNAL,
  provider,
  publicRuntime,
  type BridgeMessage,
  type JsonObject,
  type PromptJournalEntry,
  type SessionState,
} from "./acp-context.js";
import { boundTranscript } from "./acp-transcript.js";
import { schedulePersist } from "./acp-persistence.js";

export function publicSession(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    id: state.id,
    provider,
    status: state.status,
    error: state.error,
    messages: state.messages,
    // Absolute index of `messages[0]`. Clients anchor their incremental reads
    // to this so evictions from the front of the transcript cannot silently
    // shift the window they are appending to.
    baseIndex: state.droppedMessages,
    revision: state.revision,
    sessionId: state.id,
    composer: state.sessionConfig.composer,
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

export function boundTranscriptForRead(state: SessionState): void {
  /*
   * `boundTranscript` opens with a full `JSON.stringify(state.messages)`, so a
   * poll of a large idle session would otherwise pay a whole extra pass over
   * the transcript on top of serializing and compressing the response.
   * `uncheckedTranscriptBytes` is the write path's own dirty counter and
   * `boundTranscript` resets it, so zero here means these exact messages were
   * already measured against the budget and re-measuring cannot change them.
   */
  if (state.uncheckedTranscriptBytes === 0) return;
  const previousBaseIndex = state.droppedMessages;
  const previousPartCount = state.messages.reduce(
    (total, message) => total + message.parts.length,
    0,
  );
  const truncatedCurrentMessage = boundTranscript(state);
  const nextPartCount = state.messages.reduce(
    (total, message) => total + message.parts.length,
    0,
  );
  if (
    truncatedCurrentMessage
    || state.droppedMessages !== previousBaseIndex
    || nextPartCount !== previousPartCount
  ) {
    state.revision += 1;
    schedulePersist();
  }
}

/**
 * The neutral usage snapshot, or nothing at all. Cursor's current ACP adapter
 * still omits every usage carrier, and an empty meter reading "0 tokens"
 * would claim a measurement the agent never made; the panel's own "no
 * snapshot yet" copy is the truth until a carrier arrives.
 */
export function publicContextUsage(state: SessionState) {
  return state.usage
    ? acpContextUsage(state.usage.turn, {
        ...(state.usage.modelId ? { modelId: state.usage.modelId } : {}),
        ...(state.usage.durationMs === undefined ? {} : { durationMs: state.usage.durationMs }),
        updatedAt: state.usage.updatedAt,
      })
    : null;
}

/**
 * Incremental transcript read. Only the last message mutates (its parts grow as
 * chunks arrive), so a client re-requests from its own last index and receives
 * that message plus anything newer — never the whole transcript, which is
 * bounded below 16 MiB and would otherwise be re-sent on every poll.
 */
export function messageWindow(state: SessionState, fromIndex: number | null): JsonObject {
  const start = fromIndex === null
    ? 0
    : Math.min(Math.max(fromIndex - state.droppedMessages, 0), state.messages.length);
  return {
    messages: state.messages.slice(start),
    baseIndex: state.droppedMessages + start,
    totalMessages: state.droppedMessages + state.messages.length,
    messageWindow: {
      truncated: state.transcriptTruncated || state.droppedMessages + start > 0,
      ...(state.droppedMessages + start > 0
        ? { omittedMessages: state.droppedMessages + start }
        : {}),
      ...(state.droppedParts > 0 ? { omittedParts: state.droppedParts } : {}),
    },
    revision: state.revision,
    status: state.status,
    error: state.error,
  };
}

export function parseFromIndex(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function publicApprovals(state: SessionState): unknown[] {
  return [...state.approvals.values()].map(({ id, title, options, requestedAt, expiresAt }) => ({
    id,
    title,
    options,
    approvalId: id,
    kind: "permissions",
    permissions: { fileSystem: true },
    actionable: true,
    requestedAt,
    expiresAt,
  }));
}

export function setStructuredResult(state: SessionState, requestId: string, value: unknown): void {
  if (!state.structured.has(requestId) && state.structured.size >= MAX_STRUCTURED_RESULTS) {
    const oldest = state.structured.keys().next().value;
    if (typeof oldest === "string") state.structured.delete(oldest);
  }
  state.structured.set(requestId, value);
}

export function setPromptJournal(state: SessionState, entry: PromptJournalEntry): void {
  if (!state.promptJournal.has(entry.requestId) && state.promptJournal.size >= MAX_PROMPT_JOURNAL) {
    const oldest = state.promptJournal.keys().next().value;
    if (typeof oldest === "string") state.promptJournal.delete(oldest);
  }
  state.promptJournal.set(entry.requestId, entry);
}
