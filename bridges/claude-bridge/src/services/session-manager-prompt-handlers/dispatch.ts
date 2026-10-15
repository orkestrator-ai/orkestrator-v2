import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  isHandledSdkMessageType,
  isKnownInternalSdkMessageType,
  sessionHealth,
} from "../../types/index.js";
import { observeClaudeMessage } from "../diagnostics.js";
import { debugLog, isDebugLoggingEnabled } from "../logger.js";
import { armContinuationWatchdog } from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { handleAssistantMessage } from "./assistant.js";
import type { PromptMessageHandler } from "./context.js";
import { handleInitMessage } from "./init.js";
import { LEAF_MESSAGE_HANDLERS } from "./leaf.js";
import { handleResultMessage } from "./result.js";
import { handleSystemMessage } from "./system.js";
import { handleUserMessage } from "./user.js";

/** `init` is the one `system` subtype with a module of its own. */
function handleSystemFrame(turn: TurnState, message: SDKMessage): Promise<void> {
  return message.type === "system" && message.subtype === "init"
    ? handleInitMessage(turn, message)
    : handleSystemMessage(turn, message);
}

/**
 * Everything the table does not claim.
 *
 * `HANDLED_SDK_MESSAGE_TYPES` is a `Record` over the SDK's own union, so a
 * type it does not name is an SDK addition and is counted; a type it names
 * as `false` is a documented gap this bridge has not filled yet and is
 * counted too — the point is that neither is silent. Names only: an SDK
 * message body carries prompts, file contents and tool output.
 */
function handleUnknownMessage(turn: TurnState, message: SDKMessage): void {
  // An internal CLI frame outside the SDK's union that the bridge has read and
  // needs nothing from. Not drift: counting it flagged every prompt as an
  // unrecognised event.
  if (isKnownInternalSdkMessageType(message.type)) return;
  sessionHealth(turn.session).recordUnknown(
    isHandledSdkMessageType(message.type)
      ? `unconsumed:${message.type}`
      : String(message.type ?? "(untyped)"),
  );
}

const MESSAGE_HANDLERS: Partial<Record<SDKMessage["type"], PromptMessageHandler>> = {
  ...LEAF_MESSAGE_HANDLERS,
  system: handleSystemFrame,
  assistant: handleAssistantMessage,
  user: handleUserMessage,
  result: handleResultMessage,
};

/** The handler for one SDK frame, by its `type`. */
export function promptMessageHandler(type: unknown): PromptMessageHandler {
  return (
    (typeof type === "string" && Object.hasOwn(MESSAGE_HANDLERS, type)
      ? MESSAGE_HANDLERS[type as SDKMessage["type"]]
      : undefined) ?? handleUnknownMessage
  );
}

/** One SDK frame routed to this turn by the runtime's single consumer. */
export async function handleTurnMessage(turn: TurnState, message: SDKMessage): Promise<void> {
  const { sessionId, abortController, stream, diagnostics } = turn;
  if (abortController.signal.aborted) {
    return;
  }

  turn.sdkMessageCount += 1;
  // A superseded turn still draws frames for its own tools, after its
  // diagnostics have closed.
  if (diagnostics && !turn.queryEnded) observeClaudeMessage(diagnostics, message);
  // Any frame is evidence the provider is still answering the notification,
  // so the watchdog is pushed out rather than allowed to expire mid-stream.
  // Retention itself is dropped by the reclaim, the result, or the watchdog
  // firing — never by liveness alone.
  if (turn.retainedContinuationTimer) armContinuationWatchdog(turn);
  // Fires once per streamed delta — i.e. per token. Both the object
  // literal and the write are guarded, not just the write.
  if (isDebugLoggingEnabled) {
    debugLog("[session-manager] SDK event received", {
      sessionId,
      type: message.type,
      subtype: "subtype" in message ? message.subtype : undefined,
      sdkMessageCount: turn.sdkMessageCount,
    });
  }

  // Deltas are coalesced; everything else must observe them in order, so
  // settle the pending snapshot before handling a non-delta message.
  if (message.type !== "stream_event") stream.flushStreamedAssistantMessage();

  // Only the handlers that must finish a control round trip before the
  // next frame return a promise; the rest complete synchronously, exactly
  // as the branches they replaced did.
  const handled = promptMessageHandler(message.type)(turn, message);
  if (handled) await handled;
}
