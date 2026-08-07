import { parseJsonPayload, type JsonPayload } from "@/lib/chat/json-payload";
import type { NativeMessage } from "@/lib/chat/native-message-types";

function isPayloadKind(value: string, kind: JsonPayload["kind"]): boolean {
  return parseJsonPayload(value)?.kind === kind;
}

function hasMessageContent(message: NativeMessage): boolean {
  return message.parts.length > 0 || message.content.length > 0;
}

/**
 * Provider transcripts may echo schema-constrained payloads as JSON while the
 * turn is still working. The pipeline's validated report remains available in
 * its report view, so the review transcript removes report-shaped JSON from
 * ordinary progress. This is presentation filtering, never a success or
 * validation fallback.
 */
export function hideRawStructuredReviewMessages(
  messages: NativeMessage[],
): NativeMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    const parts = message.parts.filter(
      (part) =>
        part.type !== "text" || !isPayloadKind(part.content, "structured-review"),
    );
    const content = isPayloadKind(message.content, "structured-review")
      ? ""
      : message.content;
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}

interface VerificationPayloadPosition {
  messageIndex: number;
  partIndex?: number;
}

/**
 * Keep at most the completed turn's last verification verdict.
 *
 * A tool-using provider can emit several agent messages in one turn. The
 * verification prompt used to force every one of those progress messages into
 * the verdict schema, so a provisional `complete: false` looked like a real
 * failed validation. While the stage is running no verdict is authoritative;
 * once it is idle, the provider contract makes only the last agent message the
 * structured result.
 */
export function showOnlyFinalVerificationMessage(
  messages: NativeMessage[],
  showFinal: boolean,
): NativeMessage[] {
  let final: VerificationPayloadPosition | undefined;
  const verdictParts = new Set<string>();
  const verdictContentMessages = new Set<number>();

  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    let foundPart = false;
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "text" || !isPayloadKind(part.content, "verification")) {
        return;
      }
      foundPart = true;
      verdictParts.add(`${messageIndex}:${partIndex}`);
      final = { messageIndex, partIndex };
    });
    // Native providers normally duplicate the last text part into `content`.
    // Treat it as a fallback only when this message has no verdict text part,
    // otherwise retaining both would duplicate the final result again.
    if (!foundPart && isPayloadKind(message.content, "verification")) {
      verdictContentMessages.add(messageIndex);
      final = { messageIndex };
    } else if (foundPart && isPayloadKind(message.content, "verification")) {
      verdictContentMessages.add(messageIndex);
    }
  });

  return messages.flatMap((message, messageIndex) => {
    if (message.role !== "assistant") return [message];
    const parts = message.parts.filter((_part, partIndex) =>
      !verdictParts.has(`${messageIndex}:${partIndex}`)
      || (
        showFinal
        && final?.messageIndex === messageIndex
        && final.partIndex === partIndex
      )
    );
    const contentIsVerdict = verdictContentMessages.has(messageIndex);
    const content = contentIsVerdict
      && !(
        showFinal
        && final?.messageIndex === messageIndex
        && final.partIndex === undefined
      )
      ? ""
      : message.content;
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}
