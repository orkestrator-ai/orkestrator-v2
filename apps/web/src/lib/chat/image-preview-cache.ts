/**
 * Bounded cache for decoded image attachment previews.
 *
 * A `FilePart`'s decoded data URL lives in component state, and the transcript
 * is virtualized, so without this cache scrolling a message out of view and
 * back re-reads the file from the backend — a `docker exec` round trip for
 * container environments. Entries are base64 data URLs and can be megabytes
 * each, so the cache is bounded by entry count and by the window's shared
 * `images` byte budget (plan item 3016: one budget for every live node, so
 * per-node previews do not multiply memory), and evicts least-recently-used
 * first. A single oversized preview is never retained: it would evict
 * everything else to hold one image.
 *
 * Entries are keyed by `(nodeId, key)`: the same path on two nodes is two
 * files. Every read here goes through the command node today, so `nodeId`
 * defaults to the command scope's (`richContentNodeId()`).
 *
 * Only bytes that cannot change belong here (inline, remote, or a pinned copy
 * of a file; see `media-resolver.ts`). A key names a reference, not a version,
 * so a live read of a file cached under it would be shown after the file had
 * been overwritten.
 */
import type { TranscriptMediaSnapshot } from "@orkestrator/protocol/transcript-media-pins";
import { NodeByteCache, richContentNodeId } from "./rich-byte-cache";

const MAX_ENTRIES = 32;
/** A data URL is ASCII, so its length is its size in bytes. */
const MAX_ENTRY_CHARS = 8 * 1024 * 1024;

export interface ImagePreviewDimensions {
  width: number;
  height: number;
}

interface ImagePreviewEntry {
  source: string;
  dimensions?: ImagePreviewDimensions;
  snapshot?: TranscriptMediaSnapshot;
}

const entries = new NodeByteCache<ImagePreviewEntry>({
  name: "image-preview",
  budget: "images",
  maxEntries: MAX_ENTRIES,
  maxEntryBytes: MAX_ENTRY_CHARS,
});

export function imagePreviewCacheKey(
  containerId: string | undefined,
  path: string,
  fileUrl: string | undefined,
  detailRef?: string,
): string {
  return `${containerId ?? ""}\u0000${path}\u0000${fileUrl ?? ""}\u0000${detailRef ?? ""}`;
}

export function readImagePreviewCache(key: string, nodeId = richContentNodeId()): string | null {
  // `get` re-inserts, so a preview that is still being looked at is evicted last.
  return entries.get(nodeId, key)?.source ?? null;
}

/** Dimensions share the source's byte/count bounds and eviction lifetime. */
export function readImagePreviewDimensions(
  key: string,
  source: string | null,
  nodeId = richContentNodeId(),
): ImagePreviewDimensions | null {
  const entry = entries.peek(nodeId, key);
  return entry?.source === source ? (entry.dimensions ?? null) : null;
}

/** Provenance of a pinned file's bytes, stored with them. */
export function readImagePreviewSnapshot(
  key: string,
  source: string | null,
  nodeId = richContentNodeId(),
): TranscriptMediaSnapshot | null {
  const entry = entries.peek(nodeId, key);
  return entry?.source === source ? (entry.snapshot ?? null) : null;
}

export function writeImagePreviewDimensions(
  key: string,
  source: string,
  dimensions: ImagePreviewDimensions,
  nodeId = richContentNodeId(),
): void {
  const entry = entries.peek(nodeId, key);
  if (
    entry?.source === source &&
    Number.isFinite(dimensions.width) &&
    Number.isFinite(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0
  ) {
    entry.dimensions = { ...dimensions };
  }
}

export function writeImagePreviewCache(
  key: string,
  dataUrl: string,
  snapshot?: TranscriptMediaSnapshot,
  nodeId = richContentNodeId(),
): void {
  const existing = entries.peek(nodeId, key);
  if (snapshot?.status === "live" || dataUrl.length > MAX_ENTRY_CHARS) {
    entries.delete(nodeId, key);
    return;
  }
  const provenance = snapshot ?? (existing?.source === dataUrl ? existing.snapshot : undefined);
  entries.set(
    nodeId,
    key,
    {
      source: dataUrl,
      dimensions: existing?.source === dataUrl ? existing.dimensions : undefined,
      ...(provenance ? { snapshot: { ...provenance } } : {}),
    },
    dataUrl.length,
  );
}

/**
 * References whose bytes could not be read, newest last, per node.
 *
 * The transcript is virtualized, so a row that failed once comes back every
 * time the user scrolls past it. Without this, a synthesized preview would
 * re-issue the same refused `docker exec` or host read on each remount. Only
 * keys, so the bound is a count.
 */
const unavailable = new Set<string>();
const MAX_UNAVAILABLE_ENTRIES = 128;
const unavailableId = (nodeId: string, key: string) => `${nodeId}\u0000${key}`;

export function markImagePreviewUnavailable(key: string, nodeId = richContentNodeId()): void {
  const id = unavailableId(nodeId, key);
  unavailable.delete(id);
  unavailable.add(id);
  while (unavailable.size > MAX_UNAVAILABLE_ENTRIES) {
    const oldest = unavailable.values().next();
    if (oldest.done) break;
    unavailable.delete(oldest.value);
  }
}

export function isImagePreviewUnavailable(key: string, nodeId = richContentNodeId()): boolean {
  return unavailable.has(unavailableId(nodeId, key));
}

/** Entries held, and their bytes (all nodes). */
export function imagePreviewCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: entries.bytes };
}

/** Drop one node's previews (its credential, connection or identity changed). */
export function clearImagePreviewCacheForNode(nodeId: string): void {
  entries.clearNode(nodeId);
  const prefix = unavailableId(nodeId, "");
  for (const id of Array.from(unavailable)) if (id.startsWith(prefix)) unavailable.delete(id);
}

/**
 * Drop every entry. Tests call this between cases so a cached preview from one
 * case cannot suppress the backend read another case is asserting on.
 */
export function clearImagePreviewCache(): void {
  entries.clear();
  unavailable.clear();
}
