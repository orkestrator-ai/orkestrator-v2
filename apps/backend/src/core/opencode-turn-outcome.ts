import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  boundedOpenCodeMessageHistory,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import { assertSdkResponse, asRecord } from "./agent-provider-runtime.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { normalizeOpenCodeTerminalState } from "./opencode-messages.js";

/**
 * How one request's OpenCode turn ended: its terminal error, or null when the
 * turn finished cleanly.
 *
 * OpenCode's lifecycle returns to idle after a failed or aborted turn and keeps
 * the failure on the assistant message answering the request, so an idle
 * status alone is not evidence that the turn succeeded. The lifecycle can also
 * read idle just after a prompt is accepted, before any answer exists; only a
 * finished or failed answer settles the turn, and anything else throws.
 */
export async function readOpenCodeTurnTerminalError(
  client: OpencodeClient,
  sessionId: string,
  requestId: string,
  requestOptions: { signal: AbortSignal },
): Promise<string | null> {
  const marker = openCodeRequestMarker(requestId);
  const response = await client.session.messages(
    { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
    requestOptions,
  );
  assertSdkResponse(response, "OpenCode turn outcome read");
  const history = boundedOpenCodeMessageHistory(response.data);
  // The request's last assistant message carries how its turn ended.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const info = asRecord(asRecord(history[index])?.info);
    if (
      info?.role === "assistant" &&
      typeof info.parentID === "string" &&
      info.parentID.endsWith(marker)
    ) {
      const terminal = normalizeOpenCodeTerminalState(history[index]);
      if (terminal) return terminal.message;
      if (typeof asRecord(info.time)?.completed === "number") return null;
      break;
    }
  }
  throw new ProviderUnavailableError("OpenCode has not finished answering this request");
}
