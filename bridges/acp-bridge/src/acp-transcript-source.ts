import type { BridgeTranscriptSource } from "@orkestrator/protocol/node/bridge-transcript-routes";
import type { BridgeMessage, SessionState } from "./acp-context.js";

/**
 * What every transcript route of one session reads right now.
 *
 * `GET /session/:id/transcript`, `/transcript/detail` and `/transcript/page`
 * all build from this, so a detail locator or history cursor is resolved
 * against the same array, generation and epoch it was minted from. Callers
 * apply `boundTranscriptForRead` first, as every transcript read does.
 * `droppedMessages` is the absolute index of `messages[0]`, so a front trim
 * starts a new epoch and a cursor from before it expires.
 */
export function acpTranscriptSource(
  state: SessionState,
  generation: string,
): BridgeTranscriptSource<BridgeMessage> {
  return {
    messages: state.messages,
    sessionIdentity: state.id,
    generation,
    contentEpoch: state.droppedMessages,
    revision: state.revision,
    complete: !state.transcriptTruncated && state.droppedMessages === 0,
    ...(state.title ? { title: state.title } : {}),
    // Rows changed after newer ones followed them. Those already outside the
    // live window travel with the v2 summary as `revisedMessages`.
    ...(state.revisedRows
      ? {
          revisedMessageIds: state.revisedRows.ids(),
          revisedRowsOverflowVersion: state.revisedRows.overflowVersion,
        }
      : {}),
  };
}
