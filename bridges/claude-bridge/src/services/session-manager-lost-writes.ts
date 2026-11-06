import type { SDKSessionWritesLostMessage } from "@anthropic-ai/claude-agent-sdk";
import { NATIVE_AGENT_LOST_WRITE_ADVISORY } from "@orkestrator/protocol/native-agent-lost-writes";
import type { NormalizedMessage, SessionState } from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import { debugLog } from "./logger.js";
import { updateSessionPreferences } from "./session-preferences.js";
import { markTranscriptChanged } from "./transcript-revision.js";

/**
 * The lost-write advisory for a Claude session.
 *
 * The CLI reports `session_writes_lost` at most once per process, as it exits
 * (often minutes after the turn: a warm CLI exits when its idle window closes),
 * and the rollout it failed to write cannot record the loss. So the advisory is
 * a row of its own, keyed by the SDK session id, and the session preferences
 * keep when it happened, which is how a reload, an eviction or a bridge restart
 * puts the row back (`applyLostWriteAdvisory`).
 */
const ROW_ID_PREFIX = "session-writes-lost:";

function advisoryRowId(session: SessionState): string {
  return `${ROW_ID_PREFIX}${session.sdkSessionId ?? session.id}`;
}

/**
 * The shape every bridge uses for the advisory: an assistant row whose only
 * content is a warning `status` part. Not `system`: the renderer prints a
 * system row's `content` as a grey centred line and drops its severity. And
 * `content` stays empty, so the amber status line is the whole row (a row
 * with no text part also prints its `content`) and nothing that reads a turn's
 * last assistant text (coordinator status, workflow results) mistakes the
 * advisory for the agent's answer. It has no `sdkUuid`, so a fork or rewind
 * aimed at it fails closed.
 */
function advisoryRow(session: SessionState, createdAt: string): NormalizedMessage {
  return {
    id: advisoryRowId(session),
    role: "assistant",
    content: "",
    parts: [
      {
        type: "status",
        severity: "warning",
        content: NATIVE_AGENT_LOST_WRITE_ADVISORY,
        createdAt,
      },
    ],
    createdAt,
  };
}

/** Whether `message` names this session's own transcript among the losses. */
function namesThisTranscript(session: SessionState, message: SDKSessionWritesLostMessage): boolean {
  const sdkSessionId = session.sdkSessionId;
  if (!sdkSessionId) return false;
  if (!Array.isArray(message.lost) || !message.lost.includes("transcript")) return false;
  const ids = message.transcript_session_ids;
  return Array.isArray(ids) && ids.includes(sdkSessionId);
}

/**
 * `session_writes_lost`: add the advisory when this session's transcript lost
 * lines. A `global_config`-only loss, or one naming another session (a CLI
 * that `/clear`ed into a new one lists the old), stays a health notice.
 */
export function recordClaudeSessionWritesLost(
  session: SessionState,
  sessionId: string,
  message: SDKSessionWritesLostMessage,
): void {
  if (!namesThisTranscript(session, message)) return;
  // Once per session: the CLI may report again from a later process, and the
  // advisory already says everything a second copy would.
  if (session.writesLostAt) return;
  const createdAt = new Date().toISOString();
  session.writesLostAt = createdAt;
  const row = advisoryRow(session, createdAt);
  if (!session.messages.some((candidate) => candidate.id === row.id)) {
    // The newest row: frames for this session have all arrived by now.
    session.messages.push(row);
    markTranscriptChanged(session);
    eventEmitter.emit({ type: "message.updated", sessionId, data: { message: row } });
  }
  const sdkSessionId = session.sdkSessionId;
  if (!sdkSessionId) return;
  // Best effort: the same full disk may refuse this write too. The row is in
  // memory either way, for as long as this process holds the transcript.
  void updateSessionPreferences(sdkSessionId, { writesLostAt: createdAt }).catch(() => {
    debugLog("[session-manager] Lost-write advisory not persisted", { sessionId });
  });
}

/**
 * Put the advisory back into a transcript read from the rollout. Placed by
 * time, before the first row newer than the report, so a reload shows it where
 * the live tab did rather than under every later turn.
 */
export function applyLostWriteAdvisory(session: SessionState): void {
  const createdAt = session.writesLostAt;
  if (!createdAt) return;
  const id = advisoryRowId(session);
  if (session.messages.some((message) => message.id === id)) return;
  const at = Date.parse(createdAt);
  const index = session.messages.findIndex((message) => {
    const time = Date.parse(message.createdAt);
    return Number.isFinite(time) && time > at;
  });
  const row = advisoryRow(session, createdAt);
  if (index < 0) session.messages.push(row);
  else session.messages.splice(index, 0, row);
  markTranscriptChanged(session);
}
