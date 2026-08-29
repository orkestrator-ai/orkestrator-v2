import { parseJsonPayload, type JsonPayload } from "@/lib/chat/json-payload";
import { isWithheldMachineOutput, lastMachineJsonDocument } from "@/lib/chat/machine-output-text";
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
  /** A concatenated machine-output sequence is replaced by its final document. */
  replacement?: string;
}

function matchingPayload(
  value: string,
  kind: JsonPayload["kind"],
): { replacement?: string } | null {
  if (isPayloadKind(value, kind)) return {};
  const lastDocument = lastMachineJsonDocument(value);
  if (!lastDocument || !isPayloadKind(lastDocument, kind)) return null;
  return { replacement: lastDocument };
}

/** Remove every matching payload, or retain only the last one as authoritative. */
function showOnlyFinalPayloadMessage(
  messages: NativeMessage[],
  kind: JsonPayload["kind"],
  showFinal: boolean,
): NativeMessage[] {
  let final: PayloadPosition | undefined;
  const payloadParts = new Map<string, { replacement?: string }>();
  const payloadContentMessages = new Map<number, { replacement?: string }>();

  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    let foundPart = false;
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "text") return;
      const match = matchingPayload(part.content, kind);
      if (!match) return;
      foundPart = true;
      payloadParts.set(`${messageIndex}:${partIndex}`, match);
      final = { messageIndex, partIndex, ...match };
    });
    // Native providers normally duplicate the last text part into `content`.
    // Treat it as a fallback only when this message has no matching text part,
    // otherwise retaining both would duplicate the final payload again.
    const contentMatch = matchingPayload(message.content, kind);
    if (!foundPart && contentMatch) {
      payloadContentMessages.set(messageIndex, contentMatch);
      final = { messageIndex, ...contentMatch };
    } else if (foundPart && contentMatch) {
      payloadContentMessages.set(messageIndex, contentMatch);
    }
  });

  return messages.flatMap((message, messageIndex) => {
    if (message.role !== "assistant") return [message];
    let partsChanged = false;
    const parts = message.parts.flatMap((part, partIndex) => {
      const match = payloadParts.get(`${messageIndex}:${partIndex}`);
      if (!match) return [part];
      if (!(showFinal && final?.messageIndex === messageIndex && final.partIndex === partIndex)) {
        partsChanged = true;
        return [];
      }
      if (match.replacement && match.replacement !== part.content) {
        partsChanged = true;
        return [{ ...part, content: match.replacement }];
      }
      return [part];
    });
    const contentIsPayload = payloadContentMessages.has(messageIndex);
    const keepContent =
      contentIsPayload &&
      showFinal &&
      final?.messageIndex === messageIndex &&
      final.partIndex === undefined;
    let content = contentIsPayload
      ? keepContent
        ? (payloadContentMessages.get(messageIndex)?.replacement ?? message.content)
        : ""
      : message.content;
    if (!contentIsPayload && partsChanged) {
      // Some persisted adapters derive `content` by concatenating every text
      // part rather than mirroring only the final one. Once a provisional
      // payload part is removed or replaced, rebuild that fallback as well so
      // transcript search or a content-only renderer cannot recover hidden JSON.
      content = parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("");
    }
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}

/**
 * Withhold every agent text block that is a JSON document rather than prose.
 *
 * A schema-constrained turn is answered with one JSON document, and providers
 * that write it into the text channel — Codex, Cursor, and Grok — also emit
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
    let content = isWithheld(message.content) ? "" : message.content;
    if (parts.length !== message.parts.length && content === message.content) {
      // Persisted pipeline adapters can concatenate every text part into
      // `content`, so a prose update followed by machine output is neither a
      // standalone document nor safe to retain verbatim. Once a part was
      // withheld, rebuild this fallback from the surviving visible text.
      content = parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("");
    }
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
