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
 * current view token equals the delta's `baseToken`. A per-message part digest
 * also checks the local base, which can differ after a renderer remount.
 * Anything that
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

export const NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION = 2 as const;

const MAX_PATCH_PARTS = 4_096;
const MAX_PATCHES = 4_096;
const MAX_FIELDS = 64;
/** Nested part arrays a patch may descend into, and how deep. */
const NESTED_FIELDS = ["parts", "childTools", "subagentActions"] as const;
type NestedField = (typeof NESTED_FIELDS)[number];
const MAX_NESTING = 4;

export type NativeAgentPartPatch =
  /** The previous part at this index, unchanged. */
  | { keep: number }
  /** The previous part at this index with text appended to its `content`. */
  | { keep: number; length: number; append: string }
  /**
   * The previous part at this index with a few fields replaced (`set`) or
   * removed (`unset`), and optionally one nested part array (a sub-agent's
   * actions, a group's tools) patched recursively.
   */
  | {
      keep: number;
      set?: Record<string, unknown>;
      unset?: string[];
      field?: NestedField;
      children?: NativeAgentPartPatch[];
    }
  /** A new or changed part. */
  | { value: unknown };

export interface NativeAgentMessagePatch {
  id: string;
  basePartsCount: number;
  basePartsDigest: string;
  /** Every message field except `id`, `parts` and `content`, as in the new message. */
  fields: Record<string, unknown>;
  content: { length: number; append: string } | { value: string };
  parts: NativeAgentPartPatch[];
}

type Encode = (value: unknown) => string;

const defaultEncode: Encode = (value) => JSON.stringify(value) ?? "null";

function partsDigest(parts: readonly unknown[]): string {
  const serialized = JSON.stringify(parts);
  let first = 2_166_136_261;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

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

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A keep-with-changes patch: the fields that differ, and at most one nested
 * part array descended into. Undefined when it would not be clearly smaller
 * than sending the part itself.
 */
function fieldPatch(
  candidate: Record<string, unknown>,
  part: Record<string, unknown>,
  keep: number,
  encode: Encode,
  depth: number,
): NativeAgentPartPatch | undefined {
  let field: NestedField | undefined;
  if (depth < MAX_NESTING) {
    field = NESTED_FIELDS.find(
      (name) =>
        Array.isArray(candidate[name]) &&
        Array.isArray(part[name]) &&
        (part[name] as unknown[]).length <= MAX_PATCH_PARTS &&
        encode(candidate[name]) !== encode(part[name]),
    );
  }
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of new Set([...Object.keys(candidate), ...Object.keys(part)])) {
    if (key === field || FORBIDDEN_KEYS.has(key)) continue;
    if (!(key in part)) {
      unset.push(key);
    } else if (!(key in candidate) || encode(candidate[key]) !== encode(part[key])) {
      set[key] = part[key];
    }
  }
  if (Object.keys(set).length + unset.length > MAX_FIELDS) return undefined;
  const patch: NativeAgentPartPatch = {
    keep,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
    ...(field
      ? {
          field,
          children: buildPartPatches(
            candidate[field] as unknown[],
            part[field] as unknown[],
            encode,
            depth + 1,
          ),
        }
      : {}),
  };
  // Only worth it when it is clearly smaller than the part it replaces.
  return (JSON.stringify(patch) ?? "").length * 2 < encode(part).length ? patch : undefined;
}

function buildPartPatches(
  previousParts: readonly unknown[],
  nextParts: readonly unknown[],
  encode: Encode,
  depth: number,
): NativeAgentPartPatch[] {
  const previousByKey = new Map<string, number>();
  previousParts.forEach((part, index) => {
    const key = partKey(part);
    if (key !== undefined && !previousByKey.has(key)) previousByKey.set(key, index);
  });
  return nextParts.map((part, index): NativeAgentPartPatch => {
    const key = partKey(part);
    const candidateIndex = key !== undefined ? previousByKey.get(key) : index;
    const candidate = candidateIndex === undefined ? undefined : previousParts[candidateIndex];
    if (candidateIndex === undefined || candidate === undefined) return { value: part };
    if (candidate === part || encode(candidate) === encode(part)) return { keep: candidateIndex };
    if (!isRecord(candidate) || !isRecord(part)) return { value: part };
    if (
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
    return fieldPatch(candidate, part, candidateIndex, encode, depth) ?? { value: part };
  });
}

function applyPartPatches(
  previousParts: readonly unknown[],
  patches: readonly NativeAgentPartPatch[],
): unknown[] | null {
  const parts: unknown[] = [];
  for (const entry of patches) {
    if ("value" in entry) {
      parts.push(entry.value);
      continue;
    }
    const kept = previousParts[entry.keep];
    if (kept === undefined) return null;
    if ("append" in entry) {
      if (!isRecord(kept) || typeof kept.content !== "string") return null;
      if (kept.content.length !== entry.length) return null;
      parts.push({ ...kept, content: kept.content + entry.append });
      continue;
    }
    if ("set" in entry || "unset" in entry || "field" in entry) {
      if (!isRecord(kept)) return null;
      const next: Record<string, unknown> = { ...kept, ...entry.set };
      for (const key of entry.unset ?? []) delete next[key];
      if (entry.field !== undefined) {
        if (!Array.isArray(kept[entry.field]) || !entry.children) return null;
        const children = applyPartPatches(kept[entry.field] as unknown[], entry.children);
        if (children === null) return null;
        next[entry.field] = children;
      }
      parts.push(next);
      continue;
    }
    parts.push(kept);
  }
  return parts;
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
  const parts = buildPartPatches(previous.parts, next.parts, encode, 0);

  const content = next.content.startsWith(previous.content)
    ? { length: previous.content.length, append: next.content.slice(previous.content.length) }
    : { value: next.content };
  return {
    id: next.id,
    basePartsCount: previous.parts.length,
    basePartsDigest: partsDigest(previous.parts),
    fields,
    content,
    parts,
  };
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
  if (
    previous.parts.length !== patch.basePartsCount ||
    partsDigest(previous.parts) !== patch.basePartsDigest
  )
    return null;
  const parts = applyPartPatches(previous.parts as unknown[], patch.parts);
  if (parts === null) return null;
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

function isPartPatch(value: unknown, depth = 0): value is NativeAgentPartPatch {
  if (!isRecord(value)) return false;
  if ("value" in value) return Object.keys(value).length === 1;
  if (!isCount(value.keep)) return false;
  if ("append" in value) {
    return typeof value.append === "string" && isCount(value.length);
  }
  const keys = Object.keys(value);
  if (keys.length === 1) return true;
  if (!keys.every((key) => ["keep", "set", "unset", "field", "children"].includes(key))) {
    return false;
  }
  if (value.set !== undefined) {
    if (!isRecord(value.set)) return false;
    const setKeys = Object.keys(value.set);
    if (setKeys.length > MAX_FIELDS || setKeys.some((key) => FORBIDDEN_KEYS.has(key))) {
      return false;
    }
  }
  if (value.unset !== undefined) {
    if (!Array.isArray(value.unset) || value.unset.length > MAX_FIELDS) return false;
    if (!value.unset.every((key) => typeof key === "string" && !FORBIDDEN_KEYS.has(key))) {
      return false;
    }
  }
  if (value.field === undefined) return value.children === undefined;
  return (
    depth < MAX_NESTING &&
    (NESTED_FIELDS as readonly unknown[]).includes(value.field) &&
    Array.isArray(value.children) &&
    value.children.length <= MAX_PATCH_PARTS &&
    value.children.every((child) => isPartPatch(child, depth + 1))
  );
}

/** Structural validation with explicit count bounds; content is not trusted. */
export function isNativeAgentMessagePatch(value: unknown): value is NativeAgentMessagePatch {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 4_096) {
    return false;
  }
  if (
    !isCount(value.basePartsCount) ||
    value.basePartsCount > MAX_PATCH_PARTS ||
    typeof value.basePartsDigest !== "string" ||
    !/^[a-z0-9]+:[a-z0-9]+$/.test(value.basePartsDigest)
  )
    return false;
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
    value.parts.every((part) => isPartPatch(part))
  );
}

export function isNativeAgentMessagePatchList(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= MAX_PATCHES && value.every(isNativeAgentMessagePatch)
  );
}
