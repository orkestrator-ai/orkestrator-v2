/**
 * Part-level patches for the progressive transcript delta (efficiency step 14).
 *
 * A whole-message delta resends every part of a changed message. For a turn
 * that runs many tools, each new frame re-sent all the completed cards before
 * it; for streaming prose it re-sent the whole text so far, twice (the message
 * body and its text part). A message patch instead says, per part, "keep your
 * copy", "keep your copy and append this text", or "here is the new part".
 *
 * Patches ride inside a transcript delta, which a client applies only when its
 * current view token equals the delta's `baseToken`. That token pins the exact
 * previous version of every message the server diffed against, so a patch can
 * address previous parts by index without per-part revisions. Anything that
 * does not line up — a missing message, an index out of range, a declared
 * length that does not match — rejects the whole delta, and the client falls
 * back to a snapshot. A valid prefix of an invalid batch is never applied.
 *
 * Offsets are UTF-16 code units, the length JavaScript strings report; they
 * are a consistency check, not a byte count. Byte budgets are enforced on the
 * encoded response separately.
 *
 * Negotiated: a server emits patches only for a client that asked for
 * `NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION`, and only when the patch encodes
 * smaller than the message it replaces.
 */

export const NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION = 1 as const;

const MAX_PATCH_PARTS = 4_096;
const MAX_PATCHES = 4_096;
const MAX_FIELDS = 64;

export type NativeAgentPartPatch =
  /** The previous part at this index, unchanged. */
  | { keep: number }
  /** The previous part at this index with text appended to its `content`. */
  | { keep: number; length: number; append: string }
  /** A new or changed part. */
  | { value: unknown };

export interface NativeAgentMessagePatch {
  id: string;
  /** Every message field except `id`, `parts` and `content`, as in the new message. */
  fields: Record<string, unknown>;
  content: { length: number; append: string } | { value: string };
  parts: NativeAgentPartPatch[];
}

type Encode = (value: unknown) => string;

const defaultEncode: Encode = (value) => JSON.stringify(value) ?? "null";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function partKey(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (typeof part.sourcePartId === "string") return `s:${part.sourcePartId}`;
  if (typeof part.toolUseId === "string") return `t:${part.toolUseId}`;
  return undefined;
}

function withoutContent(part: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, ...rest } = part;
  return rest;
}

/**
 * The patch that turns `previous` into `next`, or undefined when the two are
 * not the same message shape (then a whole-message upsert is the answer).
 * `encode` should memoize encodings of immutable values; it defaults to
 * `JSON.stringify`.
 */
export function buildNativeAgentMessagePatch(
  previous: unknown,
  next: unknown,
  encode: Encode = defaultEncode,
): NativeAgentMessagePatch | undefined {
  if (!isRecord(previous) || !isRecord(next)) return undefined;
  if (typeof next.id !== "string" || previous.id !== next.id) return undefined;
  if (!Array.isArray(previous.parts) || !Array.isArray(next.parts)) return undefined;
  if (typeof previous.content !== "string" || typeof next.content !== "string") return undefined;
  if (next.parts.length > MAX_PATCH_PARTS) return undefined;

  const { parts: _parts, content: _content, id: _id, ...fields } = next;
  const previousByKey = new Map<string, number>();
  previous.parts.forEach((part, index) => {
    const key = partKey(part);
    if (key !== undefined && !previousByKey.has(key)) previousByKey.set(key, index);
  });

  const parts = next.parts.map((part, index): NativeAgentPartPatch => {
    const key = partKey(part);
    const candidateIndex = key !== undefined ? previousByKey.get(key) : index;
    const candidate =
      candidateIndex === undefined ? undefined : (previous.parts as unknown[])[candidateIndex];
    if (candidateIndex === undefined || candidate === undefined) return { value: part };
    if (candidate === part || encode(candidate) === encode(part)) return { keep: candidateIndex };
    if (
      isRecord(candidate) &&
      isRecord(part) &&
      typeof candidate.content === "string" &&
      typeof part.content === "string" &&
      part.content.length > candidate.content.length &&
      part.content.startsWith(candidate.content) &&
      encode(withoutContent(candidate)) === encode(withoutContent(part))
    ) {
      return {
        keep: candidateIndex,
        length: candidate.content.length,
        append: part.content.slice(candidate.content.length),
      };
    }
    return { value: part };
  });

  const content = next.content.startsWith(previous.content)
    ? { length: previous.content.length, append: next.content.slice(previous.content.length) }
    : { value: next.content };
  return { id: next.id, fields, content, parts };
}

/**
 * Apply one patch to the previous version of its message, or null when the
 * patch does not describe that version.
 */
export function applyNativeAgentMessagePatch<TMessage>(
  previous: TMessage,
  patch: NativeAgentMessagePatch,
): TMessage | null {
  if (!isRecord(previous) || previous.id !== patch.id) return null;
  if (!Array.isArray(previous.parts) || typeof previous.content !== "string") return null;
  const previousParts = previous.parts as unknown[];
  const parts: unknown[] = [];
  for (const entry of patch.parts) {
    if ("value" in entry) {
      parts.push(entry.value);
      continue;
    }
    const kept = previousParts[entry.keep];
    if (kept === undefined) return null;
    if (!("append" in entry)) {
      parts.push(kept);
      continue;
    }
    if (!isRecord(kept) || typeof kept.content !== "string") return null;
    if (kept.content.length !== entry.length) return null;
    parts.push({ ...kept, content: kept.content + entry.append });
  }
  let content: string;
  if ("value" in patch.content) {
    content = patch.content.value;
  } else {
    if (previous.content.length !== patch.content.length) return null;
    content = previous.content + patch.content.append;
  }
  return { ...patch.fields, id: patch.id, content, parts } as TMessage;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPartPatch(value: unknown): value is NativeAgentPartPatch {
  if (!isRecord(value)) return false;
  if ("value" in value) return Object.keys(value).length === 1;
  if (!isCount(value.keep)) return false;
  if ("append" in value) {
    return typeof value.append === "string" && isCount(value.length);
  }
  return Object.keys(value).length === 1;
}

/** Structural validation with explicit count bounds; content is not trusted. */
export function isNativeAgentMessagePatch(value: unknown): value is NativeAgentMessagePatch {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 4_096) {
    return false;
  }
  if (!isRecord(value.fields) || Object.keys(value.fields).length > MAX_FIELDS) return false;
  if ("parts" in value.fields || "content" in value.fields || "id" in value.fields) return false;
  const content = value.content;
  if (!isRecord(content)) return false;
  if ("value" in content) {
    if (typeof content.value !== "string") return false;
  } else if (typeof content.append !== "string" || !isCount(content.length)) {
    return false;
  }
  return (
    Array.isArray(value.parts) &&
    value.parts.length <= MAX_PATCH_PARTS &&
    value.parts.every(isPartPatch)
  );
}

export function isNativeAgentMessagePatchList(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= MAX_PATCHES && value.every(isNativeAgentMessagePatch)
  );
}
