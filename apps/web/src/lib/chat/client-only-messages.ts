import { ERROR_MESSAGE_PREFIX, SYSTEM_MESSAGE_PREFIX } from "@/lib/opencode-client";
import type { NativeMessage, NativeMessagePart } from "./native-message-types";

export const OPTIMISTIC_MESSAGE_PREFIX = "optimistic-";

/**
 * Transcript marker written when the user interrupts a turn.
 *
 * Shared so every agent says the same thing — OpenCode used to leave no trace
 * at all, which made an interrupted turn look like one that simply produced
 * nothing.
 */
export const TURN_STOPPED_BY_USER = "Query stopped by user.";

interface OptimisticNativeAttachment {
  path: string;
  previewUrl?: string;
  name: string;
}

export function normalizeMessageContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function toOptimisticFileUrl(path: string, previewUrl?: string): string | undefined {
  if (previewUrl) {
    return previewUrl;
  }

  if (!path.startsWith("/")) {
    return undefined;
  }

  /**
   * `encodeURI` leaves `#` and `?` intact because they are legal URI
   * delimiters, so a real filename containing either — `error #1.png` — parses
   * as a fragment or query and the image resolves to the wrong (or no) file.
   * Every other character `encodeURI` escapes stays escaped.
   */
  const encodedPath = encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `file://${encodedPath}`;
}

/**
 * Fingerprints exist solely to match an optimistic user message against its
 * server echo. Optimistic messages contain only text and file parts, so tool
 * payloads (`toolOutput`, `toolArgs`) can never influence a match — a tool
 * part already fails on `type` — and serializing them made every fingerprint
 * pay for the largest fields in the transcript.
 *
 * `fileUrl` is deliberately excluded: it is an implementation detail of how a
 * file is referenced, not the identity of the attachment. The optimistic
 * projection carries the client's `previewUrl` (often a data URL) or a
 * client-encoded `file://` path, while the server echo reports its own URL
 * for the same file. Matching on it would leave every attachment-carrying
 * prompt duplicated next to its echo until the final transcript refresh. The
 * attachment's `content` (its name) still participates in the match, so a
 * genuinely different attachment keeps the optimistic message distinct.
 *
 * Known and accepted consequence: the filename is now the *whole* attachment
 * identity, so two attachments sharing a basename in different directories
 * fingerprint identically. This cannot be narrowed back down symmetrically.
 * A path-derived key would have to be computed the same way on both sides,
 * and for an image the optimistic side holds a `data:` preview URL while the
 * echo holds whatever URL the server assigned — one side has no path at all,
 * so any path-aware fingerprint would stop matching the exact case this
 * exclusion exists to fix. Retirement is ordered and budgeted
 * ({@link mergeNativeMessagesPreservingClientOnly}), so a collision retires
 * the oldest pending send rather than an arbitrary one, and both prompts are
 * still retired once both echoes arrive. The test named `retires an optimistic
 * attachment against a same-named file in a different directory` pins this
 * trade-off rather than leaving it latent.
 */
function getPartFingerprint(part: NativeMessagePart): string {
  return JSON.stringify({
    type: part.type,
    content: normalizeMessageContent(part.content),
    toolName: part.toolName,
    toolTitle: part.toolTitle,
    toolState: part.toolState,
    toolError: part.toolError,
  });
}

/**
 * Part fingerprints are sorted, so the same prompt matches its echo whichever
 * order the parts arrive in.
 *
 * A live echo is assembled part by part as frames stream in, so an
 * attachment-carrying prompt whose file part precedes its text part builds
 * `[file, text]` where the optimistic projection always builds `[text, file]`.
 * Comparing positionally made retirement depend on the server's streaming
 * order and silently deferred those prompts to the final transcript refresh —
 * the very duplicate this matching exists to remove.
 *
 * Sorting cannot merge two genuinely different messages: the aggregate
 * `content` is part of the same fingerprint and is order-sensitive, so a
 * message whose text parts are reordered still differs here.
 *
 * Empty text parts are dropped before fingerprinting because the agents
 * disagree about whether an attachment-only prompt carries one. The Codex
 * bridge omits it (`appendUserMessage` guards on `prompt.length > 0`), while
 * the OpenCode client always sends `{ type: "text", text: message }` and the
 * server echoes whatever it was given. This helper is shared, so matching on
 * the presence of a zero-length text part would leave one of the two agents
 * duplicating every attachment-only prompt beside its echo. An empty text part
 * carries no identity — the aggregate `content` already covers the prompt
 * text — so ignoring it cannot merge two genuinely different messages.
 */
function getMessageFingerprint(message: Pick<NativeMessage, "role" | "content" | "parts">): string {
  return JSON.stringify({
    role: message.role,
    content: normalizeMessageContent(message.content),
    parts: message.parts
      .filter((part) => part.type !== "text" || normalizeMessageContent(part.content).length > 0)
      .map(getPartFingerprint)
      .sort(),
  });
}

function countFingerprints(messages: NativeMessage[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const message of messages) {
    const fingerprint = getMessageFingerprint(message);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }

  return counts;
}

function mergeMessagesByTimestamp(
  incomingMessages: NativeMessage[],
  clientMessages: NativeMessage[],
): NativeMessage[] {
  const mergedMessages = [...incomingMessages];

  for (const clientMessage of clientMessages) {
    const clientTime = new Date(clientMessage.createdAt || 0).getTime();
    let insertIndex = mergedMessages.length;

    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const incomingMessage = mergedMessages[i];
      if (!incomingMessage) continue;

      const incomingTime = new Date(incomingMessage.createdAt || 0).getTime();
      if (incomingTime <= clientTime) {
        insertIndex = i + 1;
        break;
      }

      if (i === 0 && incomingTime > clientTime) {
        insertIndex = 0;
      }
    }

    mergedMessages.splice(insertIndex, 0, clientMessage);
  }

  return mergedMessages;
}

export function isOptimisticNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return message.id.startsWith(OPTIMISTIC_MESSAGE_PREFIX);
}

export function createOptimisticNativeMessage(
  messageId: string,
  text: string,
  attachments: OptimisticNativeAttachment[] = [],
  createdAt: string = new Date().toISOString(),
): NativeMessage {
  const parts: NativeMessagePart[] = [];
  // Match the Codex bridge projection: an attachment-only prompt has no empty
  // text part, so the optimistic row renders the same shape its echo will.
  // Retirement no longer depends on this — {@link getMessageFingerprint}
  // ignores empty text parts precisely because OpenCode does send one — but an
  // empty text bubble is still not something to render.
  if (text.length > 0) parts.push({ type: "text", content: text });
  parts.push(
    ...attachments.map((attachment) => ({
      type: "file" as const,
      content: attachment.name || attachment.path,
      fileUrl: toOptimisticFileUrl(attachment.path, attachment.previewUrl),
    })),
  );

  return {
    id: messageId,
    role: "user",
    content: text,
    parts,
    createdAt,
  };
}

export function isClientOnlyNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return (
    message.id.startsWith(ERROR_MESSAGE_PREFIX) ||
    message.id.startsWith(SYSTEM_MESSAGE_PREFIX) ||
    isOptimisticNativeMessage(message)
  );
}

/**
 * Carry authoritative messages that landed *while a transcript fetch was in
 * flight* over into that fetch's snapshot.
 *
 * A transcript GET is a point-in-time read. Live SSE frames keep applying
 * while it is outstanding, so a response that was computed before the user's
 * latest prompt would erase that prompt when installed verbatim. This used to
 * be masked: the optimistic bubble is client-only, so it survived the
 * overwrite and kept the prompt on screen. Now that a live backend echo
 * retires its optimistic bubble on arrival, nothing is left to mask it and the
 * prompt would vanish for the rest of the turn.
 *
 * `idsBeforeFetch` is the set of message ids the store held when the request
 * started. A message that is absent from the snapshot *and* absent from that
 * set can only have arrived live during the request, so it is appended —
 * arriving after the snapshot was computed makes the tail chronologically
 * correct. A message that was already present before the request and is absent
 * from the snapshot was genuinely removed server-side and is correctly dropped.
 *
 * Client-only messages are skipped: `mergeNativeMessagesPreservingClientOnly`
 * owns their preservation and re-orders them by timestamp. Returns `snapshot`
 * by reference when there is nothing to carry over, so the store's
 * identity-preserving no-op write still applies.
 */
export function carryOverMessagesAddedDuringFetch<T extends Pick<NativeMessage, "id">>(
  snapshot: T[],
  currentMessages: readonly T[],
  idsBeforeFetch: ReadonlySet<string>,
): T[] {
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const missed = currentMessages.filter(
    (message) =>
      !isClientOnlyNativeMessage(message) &&
      !snapshotIds.has(message.id) &&
      !idsBeforeFetch.has(message.id),
  );

  return missed.length === 0 ? snapshot : [...snapshot, ...missed];
}

export function mergeNativeMessagesPreservingClientOnly(
  existingMessages: NativeMessage[],
  incomingMessages: NativeMessage[],
): NativeMessage[] {
  const incomingMessageIds = new Set(incomingMessages.map((message) => message.id));
  const existingServerMessages = existingMessages.filter(
    (message) => !isClientOnlyNativeMessage(message),
  );
  const existingClientMessages = existingMessages.filter((message) => {
    return isClientOnlyNativeMessage(message) && !incomingMessageIds.has(message.id);
  });

  if (existingClientMessages.length === 0) {
    return incomingMessages;
  }

  const optimisticMessages = existingClientMessages.filter(isOptimisticNativeMessage);

  let clientMessagesToPreserve: NativeMessage[];
  if (optimisticMessages.length === 0) {
    // Only optimistic messages can be superseded by a server echo; error and
    // system messages are always preserved, so nothing needs fingerprinting.
    clientMessagesToPreserve = existingClientMessages;
  } else {
    // A message can only fingerprint-match an optimistic send if it shares its
    // role and normalized text, so restrict the (relatively expensive)
    // fingerprinting to that handful of candidates instead of serializing
    // every message in both lists on every snapshot.
    const optimisticContentKeys = new Set(
      optimisticMessages.map(
        (message) => `${message.role}\0${normalizeMessageContent(message.content)}`,
      ),
    );
    const couldMatchOptimistic = (message: NativeMessage): boolean =>
      optimisticContentKeys.has(`${message.role}\0${normalizeMessageContent(message.content)}`);

    const existingServerFingerprintCounts = countFingerprints(
      existingServerMessages.filter(couldMatchOptimistic),
    );
    const incomingFingerprintCounts = countFingerprints(
      incomingMessages.filter(couldMatchOptimistic),
    );
    const acknowledgedOptimisticBudgets = new Map<string, number>();

    for (const [fingerprint, incomingCount] of incomingFingerprintCounts) {
      const existingCount = existingServerFingerprintCounts.get(fingerprint) ?? 0;
      if (incomingCount > existingCount) {
        acknowledgedOptimisticBudgets.set(fingerprint, incomingCount - existingCount);
      }
    }

    clientMessagesToPreserve = existingClientMessages.filter((message) => {
      if (!isOptimisticNativeMessage(message)) {
        return true;
      }

      const fingerprint = getMessageFingerprint(message);
      const remainingBudget = acknowledgedOptimisticBudgets.get(fingerprint) ?? 0;
      if (remainingBudget <= 0) {
        return true;
      }

      acknowledgedOptimisticBudgets.set(fingerprint, remainingBudget - 1);
      return false;
    });
  }

  if (clientMessagesToPreserve.length === 0) {
    return incomingMessages;
  }

  return mergeMessagesByTimestamp(incomingMessages, clientMessagesToPreserve);
}
