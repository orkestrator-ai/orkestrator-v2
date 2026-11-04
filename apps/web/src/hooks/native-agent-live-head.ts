import { samePartContent, sameTranscriptJson } from "@/lib/chat/same-transcript-json";

/**
 * A provider identity for one part that survives its content changing: a
 * tool row keeps its `toolUseId` as it settles, and a streamed text or
 * thinking part keeps its source id and arrival time as it grows.
 */
function durablePartIdentity(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const { type, toolUseId, sourcePartId, createdAt, toolName, toolTitle, content } = part as {
    type?: unknown;
    toolUseId?: unknown;
    sourcePartId?: unknown;
    createdAt?: unknown;
    toolName?: unknown;
    toolTitle?: unknown;
    content?: unknown;
  };
  if (typeof toolUseId === "string" && toolUseId) {
    // One Codex file-change item gives every changed file the same tool id.
    if (toolName === "apply_patch" && typeof content === "string") {
      return `${String(type)}\0tool\0${toolUseId}\0${String(toolTitle)}\0${content}`;
    }
    return `${String(type)}\0tool\0${toolUseId}`;
  }
  const source = typeof sourcePartId === "string" && sourcePartId ? sourcePartId : undefined;
  const arrived = typeof createdAt === "string" && createdAt ? createdAt : undefined;
  if (!source && !arrived) return undefined;
  return `${String(type)}\0${source ?? ""}\0${arrived ?? ""}`;
}

/**
 * Where `incoming` (a contiguous run of one message's parts) starts inside the
 * `local` copy of that message, or -1 when the two cannot be proven to overlap.
 *
 * Parts with a durable identity match on it. Parts without one must be equal,
 * except the last local part, which may still have been streaming when this
 * client read it; that loose match never counts on its own.
 */
function locateIncomingParts(
  local: readonly unknown[],
  incoming: readonly unknown[],
  hint: number | undefined,
): number {
  if (local.length === 0 || incoming.length === 0) return -1;
  const match = (localIndex: number, incomingIndex: number): "strict" | "loose" | false => {
    const held = durablePartIdentity(local[localIndex]);
    const next = durablePartIdentity(incoming[incomingIndex]);
    if (held !== undefined || next !== undefined) {
      if (held === next) return "strict";
      // A bridge may reissue source ids for otherwise identical parts.
      return samePartContent(local[localIndex], incoming[incomingIndex]) ? "strict" : false;
    }
    if (sameTranscriptJson(local[localIndex], incoming[incomingIndex])) return "strict";
    const heldPart = local[localIndex] as { type?: unknown; content?: unknown } | null;
    const nextPart = incoming[incomingIndex] as { type?: unknown; content?: unknown } | null;
    const growsHeldText =
      heldPart?.type === "text" &&
      nextPart?.type === "text" &&
      typeof heldPart.content === "string" &&
      typeof nextPart.content === "string" &&
      nextPart.content.startsWith(heldPart.content);
    return localIndex === local.length - 1 && growsHeldText ? "loose" : false;
  };
  const overlapAt = (offset: number) => {
    const overlap = Math.min(local.length - offset, incoming.length);
    let strict = 0;
    for (let index = 0; index < overlap; index += 1) {
      const result = match(offset + index, index);
      if (!result) return 0;
      if (result === "strict") strict += 1;
    }
    return strict > 0 ? overlap : 0;
  };
  let bestOffset = -1;
  let bestOverlap = 0;
  for (let offset = 0; offset < local.length; offset += 1) {
    const overlap = overlapAt(offset);
    if (
      overlap > bestOverlap ||
      (overlap > 0 &&
        overlap === bestOverlap &&
        offset + overlap === local.length &&
        bestOffset + bestOverlap !== local.length) ||
      (overlap > 0 &&
        overlap === bestOverlap &&
        (offset + overlap === local.length) === (bestOffset + bestOverlap === local.length) &&
        (offset === hint || (bestOffset !== hint && offset > bestOffset)))
    ) {
      bestOffset = offset;
      bestOverlap = overlap;
    }
  }
  return bestOffset;
}

/**
 * The live tail may omit leading parts of its first message to fit the byte
 * window. If this client already holds a copy of that same row, lay the
 * incoming parts over it at the offset where they overlap: the local copy
 * supplies the leading parts the window cut, so the cut cannot open a hole in
 * the middle of a turn the tab has already rendered, and the incoming parts
 * stay authoritative for everything they cover, including parts appended
 * since the tab last read the row.
 *
 * Choosing whole copies by part count alone froze the row: a trimmed head that
 * gained a final part still had fewer parts than the fuller copy on screen, so
 * the new part was never shown and later polls reported the view unchanged.
 * When a nonempty incoming copy cannot be proven to overlap, it wins.
 */
export function preferCompleteLiveHead<TMessage>(
  held: readonly TMessage[] | undefined,
  incoming: readonly TMessage[],
  omittedParts?: number,
): { messages: TMessage[]; restoredPrefix: boolean } {
  const incomingOnly = () => ({ messages: [...incoming], restoredPrefix: false });
  if (!held?.length || incoming.length === 0) return incomingOnly();
  const head = incoming[0]!;
  const headId = (head as { id?: unknown })?.id;
  if (typeof headId !== "string") return incomingOnly();
  const local = held.find((message) => (message as { id?: unknown })?.id === headId);
  const localParts = (local as { parts?: unknown } | undefined)?.parts;
  const headParts = (head as { parts?: unknown }).parts;
  if (!Array.isArray(localParts) || !Array.isArray(headParts)) return incomingOnly();
  // The same parts prove nothing is restored and incoming wins, whatever their size. A held copy
  // exactly as long as the omitted count takes the path below, which reads it as that prefix.
  if (localParts === headParts && omittedParts !== localParts.length) return incomingOnly();
  const offset =
    headParts.length === 0 && (omittedParts ?? 0) > 0
      ? localParts.length
      : omittedParts === localParts.length
        ? localParts.length
        : locateIncomingParts(localParts, headParts, omittedParts);
  if (offset < 0 || (offset === 0 && headParts.length >= localParts.length)) {
    return incomingOnly();
  }
  const parts = [
    ...localParts.slice(0, offset),
    ...headParts,
    ...localParts.slice(offset + headParts.length),
  ];
  const sameHeadFields =
    local &&
    Object.keys(head as object).length === Object.keys(local as object).length &&
    Object.entries(head as object).every(
      ([key, value]) => key === "parts" || value === (local as Record<string, unknown>)[key],
    );
  if (
    sameHeadFields &&
    parts.length === localParts.length &&
    headParts.every((part, index) => sameTranscriptJson(part, localParts[offset + index]))
  ) {
    return { messages: [local, ...incoming.slice(1)], restoredPrefix: true };
  }
  return {
    messages: [{ ...head, parts } as TMessage, ...incoming.slice(1)],
    restoredPrefix: omittedParts === undefined ? offset > 0 : offset >= omittedParts,
  };
}
