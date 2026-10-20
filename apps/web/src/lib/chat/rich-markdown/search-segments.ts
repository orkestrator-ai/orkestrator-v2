/**
 * Semantic per-block search projection for rich transcript blocks.
 *
 * Find counts matches in a message-model projection and draws them on mounted
 * DOM text. Pairing the two by a single occurrence ordinal per row means any
 * disagreement inside one rich block (a renderer that shows slightly
 * different text) shifts every later highlight in the row. Instead, a
 * projection carries segments: one per outermost keyed rich block (code,
 * diagram, disclosure, table), identified by its stable block id and source
 * part. A match is paired with DOM ranges *inside that block* (the element
 * whose `data-rich-block-key` decodes to the same part and block id), by
 * ordinal within the block. Text outside every keyed block ("prose") keeps
 * ordinal pairing among prose ranges only.
 *
 * Offset convention (one, everywhere): offsets are UTF-16 code units, i.e.
 * JavaScript string indices, with no Unicode normalization. `start`/`end`
 * index the projected search text; `sourceStart`/`sourceEnd` index the
 * part's Markdown source as the renderer parsed it (the bounded slice, which
 * is a prefix of the original source). `findAgentChatTextMatches` reports
 * offsets in the same units.
 */

export type SearchSegmentKind = "code" | "diagram" | "details" | "table";

/** How find makes hidden content of the block visible. */
export type SearchSegmentReveal = "open-disclosure" | "show-source" | null;

export interface SearchSegment {
  /** Ordinal of the source part within the message projection. */
  part: number;
  /** Stable block id within the part (`kind:offset`, see remark-rich-markdown). */
  blockId: string;
  kind: SearchSegmentKind;
  /** UTF-16 offsets into the projected search text. */
  start: number;
  end: number;
  /** UTF-16 offsets into the part's (bounded) Markdown source, when known. */
  sourceStart: number | null;
  sourceEnd: number | null;
  reveal: SearchSegmentReveal;
}

export interface SearchProjection {
  text: string;
  segments: readonly SearchSegment[];
}

export const EMPTY_SEARCH_PROJECTION: SearchProjection = { text: "", segments: [] };

/** Shift a projection's segments into a combined text at `offset` / `part`. */
export function offsetSegments(
  segments: readonly SearchSegment[],
  offset: number,
  part: number,
): SearchSegment[] {
  return segments.map((segment) => ({
    ...segment,
    part,
    start: segment.start + offset,
    end: segment.end + offset,
  }));
}

/** The segment holding a UTF-16 offset of the projected text, if any. */
export function segmentAt(
  segments: readonly SearchSegment[],
  offset: number,
): SearchSegment | null {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) return segment;
  }
  return null;
}

/** Group identity of a match or range: a block of one part, or prose. */
export type SearchGroup = { type: "prose" } | { type: "block"; blockId: string; part: string };

export const PROSE_GROUP: SearchGroup = { type: "prose" };

export function searchGroupId(group: SearchGroup): string {
  return group.type === "prose" ? "prose" : `block\u0000${group.part}\u0000${group.blockId}`;
}

/** A model match's group: its segment's block in its part, or prose. */
export function modelMatchGroup(projection: SearchProjection, characterIndex: number): SearchGroup {
  const segment = segmentAt(projection.segments, characterIndex);
  return segment
    ? { type: "block", blockId: segment.blockId, part: String(segment.part) }
    : PROSE_GROUP;
}

/**
 * Decode a `data-rich-block-key` view key (`["block", backend, environment,
 * session, message, sourcePartId, blockId]`, see `richBlockViewKey`).
 */
export function decodeBlockViewKey(key: string): { sourcePartId: string; blockId: string } | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts[0] !== "block" || parts.length !== 7) return null;
    const [, , , , , sourcePartId, blockId] = parts;
    return typeof sourcePartId === "string" && typeof blockId === "string"
      ? { sourcePartId, blockId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Map DOM block groups (part = decoded source part id, in document order) to
 * model block groups (part = part ordinal). Blocks pair by block id; where
 * the same block id occurs in several parts of one message, the n-th part
 * (in document order) holding it pairs with the n-th model part holding it.
 */
export function pairBlockGroups(
  modelGroups: readonly Extract<SearchGroup, { type: "block" }>[],
  domGroups: readonly Extract<SearchGroup, { type: "block" }>[],
): Map<string, string> {
  const byBlock = <T extends { blockId: string; part: string }>(groups: readonly T[]) => {
    const map = new Map<string, string[]>();
    for (const group of groups) {
      const parts = map.get(group.blockId) ?? [];
      if (!parts.includes(group.part)) parts.push(group.part);
      map.set(group.blockId, parts);
    }
    return map;
  };
  const model = byBlock(modelGroups);
  for (const parts of model.values()) parts.sort((a, b) => Number(a) - Number(b));
  const dom = byBlock(domGroups);
  const pairs = new Map<string, string>();
  for (const [blockId, modelParts] of model) {
    const domParts = dom.get(blockId) ?? [];
    modelParts.forEach((part, index) => {
      const domPart = domParts[index];
      if (domPart === undefined) return;
      pairs.set(
        searchGroupId({ type: "block", blockId, part }),
        searchGroupId({ type: "block", blockId, part: domPart }),
      );
    });
  }
  return pairs;
}

export type SearchTextGetter<T> = ((item: T) => string) & {
  /** Optional semantic projection whose `text` equals the getter's result. */
  projection?: (item: T) => SearchProjection;
};

/** Attach a projection to a search-text getter (keeps the getter's identity). */
export function withSearchProjection<T>(
  getText: (item: T) => string,
  projection: (item: T) => SearchProjection,
): SearchTextGetter<T> {
  const getter = getText as SearchTextGetter<T>;
  getter.projection = projection;
  return getter;
}
