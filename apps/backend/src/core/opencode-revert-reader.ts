import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import { openCodeRevertMarker, type OpenCodeRevertMarker } from "./opencode-revert.js";
import type { OpenCodeStreamState } from "./opencode-stream-state.js";

/** Read through an unknown revert marker; a failed read retains the cached marker. */
export async function readOpenCodeRevertMarker(
  state: OpenCodeStreamState,
  sessionId: string,
  readSession: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<OpenCodeRevertMarker | undefined> {
  if (state.revertMarkerKnown(sessionId)) {
    return state.revertMarker(sessionId);
  }
  const version = state.revertVersion(sessionId);
  try {
    const response = await readSession();
    assertSdkResponse(response, "OpenCode session revert read");
    const session = asRecord(response.data);
    const marker = openCodeRevertMarker(session);
    if (session?.id === sessionId && (session.revert === undefined || marker)) {
      state.observeRevert(sessionId, marker, version);
    }
  } catch {
    // The transcript stays readable; only the marker is stale.
  }
  return state.revertMarker(sessionId);
}
