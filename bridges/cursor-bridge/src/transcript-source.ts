import type { BridgeTranscriptSource } from "@orkestrator/protocol/bridge-transcript-routes";
import type { BridgeMessage, SessionState } from "./state.js";

/**
 * What every transcript route of one session reads right now.
 *
 * `GET /session/:id/transcript`, `/transcript/detail` and `/transcript/page`
 * all build from this, so a detail locator or history cursor is resolved
 * against the same array, generation and epoch it was minted from. Callers
 * apply `boundTranscriptForRead` first, as every transcript read does.
 */
export function cursorTranscriptSource(
  state: SessionState,
  generation: string,
): BridgeTranscriptSource<BridgeMessage> {
  return {
    messages: state.messages,
    sessionIdentity: state.id,
    generation,
    // Front trimming and wholesale replacement both move absolute
    // positions, so either one starts a new epoch.
    contentEpoch: state.transcriptEpoch
      ? `${state.transcriptEpoch}:${state.droppedMessages}`
      : state.droppedMessages,
    revision: state.revision,
    complete: !state.transcriptTruncated && state.droppedMessages === 0,
  };
}
