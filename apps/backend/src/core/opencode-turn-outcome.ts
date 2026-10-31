import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import { assertSdkResponse, asRecord } from "./agent-provider-runtime.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { normalizeOpenCodeTerminalState } from "./opencode-messages.js";
import { openCodeActionFailureForMessage } from "./opencode-action-failures.js";
import type { OpenCodeDispatchFailure } from "./opencode-stream-state.js";

/**
 * How long a dispatch-time `session.error` must stand with no message for the
 * request before it settles the turn. OpenCode reports a part it cannot read
 * (a binary attachment) as a `session.error` and then still stores the
 * message, milliseconds later; a read inside that gap must not call the turn
 * failed.
 */
export const OPEN_CODE_DISPATCH_FAILURE_GRACE_MS = 2_000;

/**
 * How one request's OpenCode turn ended: its terminal error, or null when the
 * turn finished cleanly.
 *
 * OpenCode's lifecycle returns to idle after a failed or aborted turn and keeps
 * the failure on the assistant message answering the request, so an idle
 * status alone is not evidence that the turn succeeded. The lifecycle can also
 * read idle just after a prompt is accepted, before any answer exists; only a
 * finished or failed answer settles the turn, and anything else throws.
 *
 * The one exception is a prompt OpenCode accepted and then dropped: a
 * `session.error` it published after the dispatch (`dispatch.failure`) with
 * no message for the request in the transcript. That turn failed with the
 * error's reason; without the event it stays unproven.
 */
export async function readOpenCodeTurnTerminalError(
  client: OpencodeClient,
  sessionId: string,
  requestId: string,
  requestOptions: { signal: AbortSignal },
  dispatch: {
    failure?: OpenCodeDispatchFailure;
    now?: number;
    /** A retry still answers this failure (`OpenCodeCapacityRetry`). */
    retrying?: (error: unknown) => boolean;
  } = {},
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
      if (terminal?.kind === "stopped") {
        const sessionResponse = await client.session.get({ sessionID: sessionId }, requestOptions);
        assertSdkResponse(sessionResponse, "OpenCode action failure outcome read");
        return (
          openCodeActionFailureForMessage(asRecord(sessionResponse.data) ?? {}, history[index]) ??
          terminal.message
        );
      }
      if (terminal && dispatch.retrying?.(info.error)) {
        throw new ProviderUnavailableError("OpenCode is about to retry this request");
      }
      if (terminal) return terminal.message;
      if (typeof asRecord(info.time)?.completed === "number") return null;
      throw new ProviderUnavailableError("OpenCode has not finished answering this request");
    }
  }
  const failure = dispatch.failure;
  if (failure?.requestId === requestId && !findOpenCodeMessageId(history, requestId)) {
    const remaining =
      OPEN_CODE_DISPATCH_FAILURE_GRACE_MS - ((dispatch.now ?? Date.now()) - failure.observedAt);
    if (remaining > 0) {
      throw new ProviderUnavailableError("OpenCode is still resolving the prompt's attachments", {
        retryAfterMs: remaining,
      });
    }
    return `OpenCode did not accept the prompt: ${failure.message}`;
  }
  throw new ProviderUnavailableError("OpenCode has not finished answering this request");
}
