import { parseJsonPayload, type JsonPayload } from "@/lib/chat/json-payload";
import { isWithheldMachineOutput } from "@/lib/chat/machine-output-text";
import type { NativeMessage } from "@/lib/chat/native-message-types";

function isPayloadKind(value: string, kind: JsonPayload["kind"]): boolean {
  return parseJsonPayload(value)?.kind === kind;
}

function hasMessageContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.length > 0;
}

interface PayloadPosition {
  messageIndex: number;
  partIndex?: number;
}

/** Remove every matching payload, or retain only the last one as authoritative. */
function showOnlyFinalPayloadMessage(
  messages: NativeMessage[],
  kind: JsonPayload["kind"],
  showFinal: boolean,
): NativeMessage[] {
  let final: PayloadPosition | undefined;
  const payloadParts = new Set<string>();
  const payloadContentMessages = new Set<number>();

  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    let foundPart = false;
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "text" || !isPayloadKind(part.content, kind)) return;
      foundPart = true;
      payloadParts.add(`${messageIndex}:${partIndex}`);
      final = { messageIndex, partIndex };
    });
    // Native providers normally duplicate the last text part into `content`.
    // Treat it as a fallback only when this message has no matching text part,
    // otherwise retaining both would duplicate the final payload again.
    if (!foundPart && isPayloadKind(message.content, kind)) {
      payloadContentMessages.add(messageIndex);
      final = { messageIndex };
    } else if (foundPart && isPayloadKind(message.content, kind)) {
      payloadContentMessages.add(messageIndex);
    }
  });

  return messages.flatMap((message, messageIndex) => {
    if (message.role !== "assistant") return [message];
    const parts = message.parts.filter(
      (_part, partIndex) =>
        !payloadParts.has(`${messageIndex}:${partIndex}`) ||
        (showFinal && final?.messageIndex === messageIndex && final.partIndex === partIndex),
    );
    const contentIsPayload = payloadContentMessages.has(messageIndex);
    const content =
      contentIsPayload &&
      !(showFinal && final?.messageIndex === messageIndex && final.partIndex === undefined)
        ? ""
        : message.content;
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}

/**
 * Withhold every agent text block that is a JSON document rather than prose.
 *
 * A schema-constrained turn is answered with one JSON document, and providers
 * that write it into the text channel — Codex and the ACP agents — also emit
 * longer and longer *drafts* of it as their progress updates. A draft is not a
 * recognized payload (it is usually still streaming, and even when finished it
 * is a provisional report the workflow has not accepted), so nothing else
 * filters it and the reader gets a screen of raw JSON where the commentary
 * should be.
 *
 * Applied after {@link showOnlyFinalStructuredReviewMessage}, which handles the
 * documents that do validate. This is deliberately shape-based rather than
 * schema-based: it withholds a document the moment it opens, long before
 * enough of it exists to validate against anything.
 *
 * `retainPayloadKind` names the contract a preceding `showOnlyFinal*` pass owns.
 * That pass has already made an explicit keep-or-drop decision about every
 * payload of that kind, so anything of it still present was kept deliberately —
 * withholding it here would silently undo a caller's `showFinal: true`. Every
 * other document, including arbitrary JSON that happens to parse, stays subject
 * to withholding: no filter claimed it, so nothing has vouched for it.
 */
export function hideMachineOutputText(
  messages: NativeMessage[],
  options: { retainPayloadKind?: JsonPayload["kind"] } = {},
): NativeMessage[] {
  const { retainPayloadKind } = options;
  const isWithheld = (text: string): boolean => {
    if (!isWithheldMachineOutput(text)) return false;
    return retainPayloadKind === undefined || !isPayloadKind(text, retainPayloadKind);
  };
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    const parts = message.parts.filter((part) => part.type !== "text" || !isWithheld(part.content));
    // `content` mirrors the provider's last text part, so it is withheld on the
    // same terms; a message rendered from `content` alone would otherwise put
    // the document straight back on screen.
    const content = isWithheld(message.content) ? "" : message.content;
    if (parts.length === message.parts.length && content === message.content) {
      return [message];
    }
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}

/**
 * Retain only an accepted historical review's final structured report.
 * Current reports render through the dedicated pipeline-owned report view.
 */
export function showOnlyFinalStructuredReviewMessage(
  messages: NativeMessage[],
  showFinal: boolean,
): NativeMessage[] {
  return showOnlyFinalPayloadMessage(messages, "structured-review", showFinal);
}

/**
 * Keep at most the completed turn's last verification verdict.
 *
 * A tool-using provider can emit several agent messages in one turn. The
 * verification prompt used to force every one of those progress messages into
 * the verdict schema, so a provisional `complete: false` looked like a real
 * failed validation. Provider activity is not authority: pause and cancellation
 * also make a session idle. The caller shows the last payload only after the
 * backend has accepted that request's structured result.
 */
export function showOnlyFinalVerificationMessage(
  messages: NativeMessage[],
  showFinal: boolean,
): NativeMessage[] {
  return showOnlyFinalPayloadMessage(messages, "verification", showFinal);
}
