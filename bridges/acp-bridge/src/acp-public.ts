import { transcriptTailStart } from "@orkestrator/protocol/node/transcript-window";
import { acpContextUsage } from "./usage.js";
import {
  MAX_STRUCTURED_RESULTS,
  MAX_PROMPT_JOURNAL,
  provider,
  providerConfig,
  publicRuntime,
  type JsonObject,
  type ParkedDeadline,
  type PromptJournalEntry,
  type SessionState,
} from "./acp-context.js";
import { acpSessionReportedPolicy } from "./acp-policy.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { boundTranscript } from "./acp-transcript.js";
import { schedulePersist } from "./acp-persist-writer.js";

export function publicSession(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    id: state.id,
    provider,
    status: state.status,
    error: state.error,
    ...(state.title ? { title: state.title } : {}),
    messages: state.messages,
    // Absolute index of `messages[0]`. Clients anchor their incremental reads
    // to this so evictions from the front of the transcript cannot silently
    // shift the window they are appending to.
    baseIndex: state.droppedMessages,
    revision: state.revision,
    sessionId: state.id,
    composer: state.sessionConfig.composer,
    ...policyField(state),
    ...(contextUsage ? { contextUsage } : {}),
    ...publicCommandRevision(state),
    runtime: publicRuntime(state),
  };
}

/**
 * The command inventory revision, identical to `revision` on
 * `GET /session/:id/commands`. It advances on every pushed replacement, so a
 * backend polling status can notice a push and re-read the catalogue for a
 * tab that is not looking. Absent until any inventory is known.
 */
/** The `policy` field of a session's projections (`acpSessionReportedPolicy`). */
export function policyField(state: SessionState): { policy: NativeAgentExecutionPolicy } | object {
  const policy = acpSessionReportedPolicy(state, providerConfig.name);
  return policy ? { policy } : {};
}

export function publicCommandRevision(state: SessionState): { commandRevision?: number } {
  return state.commandsRevision === undefined ? {} : { commandRevision: state.commandsRevision };
}

/** Mutation acknowledgement; transcript hydration has its own bounded route. */
export function publicSessionReference(state: SessionState): JsonObject {
  return { sessionId: state.id };
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
  const nextPartCount = state.messages.reduce((total, message) => total + message.parts.length, 0);
  if (
    truncatedCurrentMessage ||
    state.droppedMessages !== previousBaseIndex ||
    nextPartCount !== previousPartCount
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
        ...(state.usage.lastTurnTokens === undefined
          ? {}
          : { lastTurnTokens: state.usage.lastTurnTokens }),
        ...(state.usage.sessionTokens === undefined
          ? {}
          : { sessionTokens: state.usage.sessionTokens }),
        ...(state.usage.turns?.length ? { turns: state.usage.turns } : {}),
        source: provider,
        updatedAt: state.usage.updatedAt,
      })
    : null;
}

/**
 * Incremental transcript read. A client re-requests from its own last index
 * and receives that message plus anything newer — never the whole transcript,
 * which is bounded below 16 MiB and would otherwise be re-sent on every poll.
 *
 * The trailing message is not the only one that changes: each model response
 * is a row of its own, and a late tool update lands on whichever row holds its
 * call. The window therefore starts no later than the oldest row changed this
 * turn (`mutatedMessageFloor`). `baseIndex` says where it starts, so a client
 * merging by it replaces those rows rather than keeping a stale copy.
 */
export function messageWindow(
  state: SessionState,
  fromIndex: number | null,
  tailMessages: number | null = null,
): JsonObject {
  const requested =
    fromIndex === null || state.mutatedMessageFloor === undefined
      ? fromIndex
      : Math.min(fromIndex, state.mutatedMessageFloor);
  // A tail read (no anchor) wants exactly the newest `tailMessages`; it merges
  // nothing, so the mutated-row floor does not apply to it.
  const start =
    requested === null
      ? transcriptTailStart(state.messages.length, tailMessages)
      : Math.min(Math.max(requested - state.droppedMessages, 0), state.messages.length);
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

/**
 * `fromIndex` shares one grammar with every other bridge's `/messages` route:
 * canonical nonnegative safe decimal, anything else is `null` (the retained
 * window). See `parseTranscriptFromIndex` in the protocol package.
 */
export { parseTranscriptFromIndex as parseFromIndex } from "@orkestrator/protocol/node/transcript-window";

/**
 * `limit` (the newest messages wanted) shares the same grammar; anything else
 * is `null` (the retained window). See `parseTranscriptTailLimit`.
 */
export { parseTranscriptTailLimit as parseTailLimit } from "@orkestrator/protocol/node/transcript-window";

/**
 * A parked request's countdown as it stands now: a pause moves `expiresAt` to
 * the ceiling it holds until, and `hold` says whether it is paused and why a
 * pause is limited or unavailable.
 */
function publicDeadline({ requestedAt, deadline }: ParkedDeadline) {
  return { requestedAt, expiresAt: deadline.expiresAt, hold: deadline.hold() };
}

/**
 * Held permission requests in ACP's own shape: the agent's title and its
 * options (allow once, always allow, reject...), which the backend offers as
 * the choices (`mapAcpApproval`), plus the approval kind and, for a command
 * or a file change, what it runs (`permissionDetail`). The Codex envelope this route used to add
 * (`approvalId`, a file-system `permissions` grant) named no tool and offered
 * no option a client could select.
 */
export function publicApprovals(state: SessionState): unknown[] {
  return [...state.approvals.values()].map((approval) => ({
    id: approval.id,
    title: approval.title,
    // `command` or `file-change` with what it runs; `permission` otherwise.
    ...(approval.detail ?? { kind: "permission" }),
    options: approval.options,
    ...publicDeadline(approval),
  }));
}

export function publicInteractions(state: SessionState): unknown[] {
  return [...state.interactions.values()].map((interaction) =>
    interaction.kind === "plan-approval"
      ? {
          id: interaction.id,
          kind: interaction.kind,
          plan: interaction.plan,
          planTruncated: interaction.planTruncated,
          ...publicDeadline(interaction),
        }
      : {
          id: interaction.id,
          kind: interaction.kind,
          questions: interaction.questions,
          ...publicDeadline(interaction),
        },
  );
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
