import { parseJsonPayload, type JsonPayload } from "@/lib/chat/json-payload";
import {
  isWithheldMachineOutput,
  jsonDocumentState,
  lastMachineJsonDocument,
} from "@/lib/chat/machine-output-text";
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
  options: {
    retainPayloadKind?: JsonPayload["kind"];
    /** ACP-style providers can append the final dataset to a prose text part. */
    stripTrailingPayload?: boolean;
  } = {},
): NativeMessage[] {
  const { retainPayloadKind, stripTrailingPayload = false } = options;
  const isWithheld = (text: string): boolean => {
    if (!isWithheldMachineOutput(text)) return false;
    return retainPayloadKind === undefined || !isPayloadKind(text, retainPayloadKind);
  };
  const visibleText = (text: string): string => {
    if (isWithheld(text)) return "";
    return stripTrailingPayload ? withoutTrailingJsonPayload(text) : text;
  };
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    let partsChanged = false;
    const parts: NativeMessage["parts"] = [];
    for (const part of message.parts) {
      if (part.type !== "text") {
        parts.push(part);
        continue;
      }
      const content = visibleText(part.content);
      if (content === part.content) {
        parts.push(part);
        continue;
      }
      partsChanged = true;
      if (content) parts.push({ ...part, content });
    }
    // `content` mirrors the provider's last text part, so it is withheld on the
    // same terms; a message rendered from `content` alone would otherwise put
    // the document straight back on screen.
    let content = visibleText(message.content);
    if (partsChanged && content === message.content) {
      // Persisted pipeline adapters can concatenate every text part into
      // `content`, so a prose update followed by machine output is neither a
      // standalone document nor safe to retain verbatim. Once a part was
      // withheld, rebuild this fallback from the surviving visible text.
      content = parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("");
    }
    if (!partsChanged && content === message.content) {
      return [message];
    }
    const filtered = { ...message, content, parts };
    return hasMessageContent(filtered) ? [filtered] : [];
  });
}

const TRAILING_PAYLOAD_SCAN_CHARS = 1024 * 1024;
const TRAILING_PAYLOAD_SCAN_CANDIDATES = 256;
const KNOWN_REVIEW_PAYLOAD_ROOT_KEYS = new Set([
  "complete",
  "headRef",
  "issues",
  "reportIndex",
  "reviewScope",
  "status",
  "validation",
  "verdict",
]);

function unfencedJsonCandidate(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json[5c]?)?[ \t]*\r?\n/i, "")
    .replace(/\r?\n?```$/, "")
    .trim();
}

function hasKnownReviewPayloadRoot(candidate: string): boolean {
  const json = unfencedJsonCandidate(candidate);
  const firstKey = /^\{\s*"([^"]+)"\s*:/.exec(json)?.[1];
  return firstKey !== undefined && KNOWN_REVIEW_PAYLOAD_ROOT_KEYS.has(firstKey);
}

function hasLineBreakBefore(text: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /[ \t\r\n]/.test(text[cursor]!)) cursor -= 1;
  return /[\r\n]/.test(text.slice(cursor + 1, index));
}

function isNonEmptyJsonDocument(candidate: string): boolean {
  const document = lastMachineJsonDocument(candidate);
  if (!document) return false;
  try {
    const value: unknown = JSON.parse(document);
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && typeof value === "object" && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

/**
 * Remove a structured JSON value appended to prose in the same provider text
 * part, including an incomplete streaming draft. Ordinary sentence-ending
 * values stay visible: a candidate must either begin on a new line or expose a
 * known review-workflow root key. Complete values must also be non-empty.
 *
 * The scan is bounded and fails open. Streaming candidates are classified by
 * delimiter state and never sent through JSON.parse.
 */
function withoutTrailingJsonPayload(text: string): string {
  const trimmed = text.trimEnd();
  const firstCandidate = Math.max(0, trimmed.length - TRAILING_PAYLOAD_SCAN_CHARS);
  let candidates = 0;
  for (let index = firstCandidate; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    const isFence =
      character === "`" &&
      trimmed.startsWith("```", index) &&
      (index === 0 || trimmed[index - 1] === "\n");
    if (character !== "{" && character !== "[" && !isFence) continue;
    if (index > 0 && !/\s/.test(trimmed[index - 1]!)) continue;
    candidates += 1;
    if (candidates > TRAILING_PAYLOAD_SCAN_CANDIDATES) return text;
    const candidate = trimmed.slice(index);
    const state = jsonDocumentState(candidate);
    if (state === "not-json") continue;
    if (!hasLineBreakBefore(trimmed, index) && !hasKnownReviewPayloadRoot(candidate)) continue;
    if (state === "complete" && !isNonEmptyJsonDocument(candidate)) continue;
    const unfinished = unfencedJsonCandidate(candidate);
    if (state === "incomplete" && unfinished.slice(1).trim().length === 0) continue;
    return trimmed.slice(0, index).trimEnd();
  }
  return text;
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
