import type { BigIntStats } from "node:fs";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";

/**
 * Parsed `session_index.jsonl`, cached per path and extended by its appended tail.
 *
 * Codex appends one line to its home's session index whenever a thread is named
 * or renamed, and never rewrites it in normal use. Every hydrate looked up one
 * thread's entry by reading and parsing the whole file; this keeps the parsed
 * entries and, on the next read, compares the path's size, mtime, ctime and
 * inode with what was parsed:
 *
 * - unchanged: nothing is read;
 * - grown on the same inode, with the bytes just before the old boundary still
 *   the same: only the appended bytes are read and parsed;
 * - anything else (shrunk, replaced, rewritten in place): read from scratch.
 *
 * It follows `transcript-cache.ts`: the size and identity labelling parsed bytes
 * come from `fstat` of the descriptor they were read from, never a later path
 * stat. An unterminated last line (a write in progress, or a file without a
 * trailing newline) is parsed with each read but never committed, so the next
 * append re-reads it whole.
 *
 * Bounded by entry count and estimated bytes across every cached path (root
 * invariant 11). An index too large for the budget on its own is not cached at
 * all: each read parses it from scratch, which is what every read did before.
 */

export interface SessionIndexEntry {
  id: string;
  threadName?: string;
  updatedAt?: string;
}

/** Entries across every cached index; a heavy Codex home has a few thousand. */
export const MAX_SESSION_INDEX_CACHE_ENTRIES = 50_000;
/** Estimated retained heap across every cached index. */
export const MAX_SESSION_INDEX_CACHE_BYTES = 16 * 1024 * 1024;
/** Distinct index paths kept: one per Codex home, so normally one. */
export const MAX_SESSION_INDEX_CACHE_PATHS = 4;

/** Estimated heap of one entry apart from its strings (object, map slot, array slot). */
const ENTRY_OVERHEAD_BYTES = 96;
/** Estimated heap of one cached index apart from its entries. */
const INDEX_OVERHEAD_BYTES = 512;
/** Bytes before the consumed boundary compared on growth to detect a rewrite. */
const ANCHOR_BYTES = 64;
const NEWLINE = 0x0a;

interface SessionIndexCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxPaths: number;
}

const DEFAULT_LIMITS: SessionIndexCacheLimits = {
  maxEntries: MAX_SESSION_INDEX_CACHE_ENTRIES,
  maxBytes: MAX_SESSION_INDEX_CACHE_BYTES,
  maxPaths: MAX_SESSION_INDEX_CACHE_PATHS,
};

let limits: SessionIndexCacheLimits = DEFAULT_LIMITS;

export function setSessionIndexCacheLimitsForTesting(
  overrides?: Partial<SessionIndexCacheLimits>,
): void {
  limits = { ...DEFAULT_LIMITS, ...overrides };
  enforceBudgets();
}

interface CachedSessionIndex {
  readonly path: string;
  /** `dev:ino` of the descriptor the bytes were read from. */
  readonly fileId: string;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** Offset just past the last newline: where committed entries end. */
  consumedEnd: number;
  /** The bytes immediately before `consumedEnd`, to detect a rewrite on growth. */
  anchor: Buffer;
  /**
   * Committed entries in file order. Appends only push; a re-read builds a new
   * index, so a snapshot holding this array and a length stays exact.
   */
  entries: SessionIndexEntry[];
  /** Position in `entries` of the last committed entry for each id. */
  lastById: Map<string, number>;
  /** The unterminated last line, when it parses; valid for exactly `size`. */
  pendingTail?: SessionIndexEntry;
  estimatedBytes: number;
}

/** What one read observed: entries in file order, and the last one per id. */
export interface SessionIndexSnapshot {
  /** Every entry in file order; a later entry for an id supersedes an earlier one. */
  entries(): readonly SessionIndexEntry[];
  last(id: string): SessionIndexEntry | undefined;
}

const EMPTY_SNAPSHOT: SessionIndexSnapshot = { entries: () => [], last: () => undefined };

/** Least recently used first: every access re-inserts. */
const cache = new Map<string, CachedSessionIndex>();
/** Serialises refreshes per path so two readers never parse the same tail twice. */
const locks = new Map<string, Promise<unknown>>();

const counters = { fullReads: 0, tailReads: 0, uncachedReads: 0, bytesRead: 0 };

export interface SessionIndexCacheStats {
  paths: number;
  entries: number;
  bytes: number;
  /** Reads that parsed an index from its first byte and cached the result. */
  fullReads: number;
  /** Reads that parsed only bytes appended since the last read. */
  tailReads: number;
  /** Reads of an index too large to cache, parsed from scratch every time. */
  uncachedReads: number;
  bytesRead: number;
}

export function getSessionIndexCacheStats(): SessionIndexCacheStats {
  let entries = 0;
  let bytes = 0;
  for (const index of cache.values()) {
    entries += index.entries.length;
    bytes += index.estimatedBytes;
  }
  return { paths: cache.size, entries, bytes, ...counters };
}

export function clearSessionIndexCache(): void {
  cache.clear();
  counters.fullReads = 0;
  counters.tailReads = 0;
  counters.uncachedReads = 0;
  counters.bytesRead = 0;
}

function entryBytes(entry: SessionIndexEntry): number {
  // JSC keeps most decoded strings as UTF-16.
  return (
    ENTRY_OVERHEAD_BYTES +
    2 * (entry.id.length + (entry.threadName?.length ?? 0) + (entry.updatedAt?.length ?? 0))
  );
}

function fitsAlone(entryCount: number, bytes: number): boolean {
  return entryCount <= limits.maxEntries && bytes <= limits.maxBytes;
}

function touch(index: CachedSessionIndex): void {
  cache.delete(index.path);
  cache.set(index.path, index);
}

function enforceBudgets(): void {
  let entries = 0;
  let bytes = 0;
  for (const index of cache.values()) {
    entries += index.entries.length;
    bytes += index.estimatedBytes;
  }
  for (const index of Array.from(cache.values())) {
    if (cache.size <= limits.maxPaths && entries <= limits.maxEntries && bytes <= limits.maxBytes) {
      return;
    }
    cache.delete(index.path);
    entries -= index.entries.length;
    bytes -= index.estimatedBytes;
  }
}

/**
 * One index line as the former whole-file readers took it: trimmed, a JSON
 * object with a string `id`, and string name and timestamp fields when present.
 */
function parseIndexLine(line: string): SessionIndexEntry | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
  if (typeof record.id !== "string") return undefined;
  return {
    id: record.id,
    ...(typeof record.thread_name === "string" ? { threadName: record.thread_name } : {}),
    ...(typeof record.updated_at === "string" ? { updatedAt: record.updated_at } : {}),
  };
}

/** Parses bytes that start on a line boundary into committed entries and a pending tail. */
function parseChunk(bytes: Buffer): {
  entries: SessionIndexEntry[];
  /** Bytes up to and including the last newline. */
  committedBytes: number;
  pendingTail?: SessionIndexEntry;
} {
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  const committedBytes = lastNewline + 1;
  const entries: SessionIndexEntry[] = [];
  if (committedBytes > 0) {
    for (const line of bytes.subarray(0, committedBytes).toString("utf8").split("\n")) {
      const entry = parseIndexLine(line);
      if (entry) entries.push(entry);
    }
  }
  const pendingTail =
    committedBytes < bytes.length
      ? parseIndexLine(bytes.subarray(committedBytes).toString("utf8"))
      : undefined;
  return { entries, committedBytes, ...(pendingTail ? { pendingTail } : {}) };
}

/**
 * The index as it is now, without copying it. A later append pushes onto the
 * same array and map, so the snapshot keeps the length it saw and ignores
 * anything at or past it.
 */
function snapshotOf(index: CachedSessionIndex): SessionIndexSnapshot {
  const { entries, lastById, pendingTail } = index;
  const length = entries.length;
  return {
    entries: () => {
      const committed = entries.slice(0, length);
      if (pendingTail) committed.push(pendingTail);
      return committed;
    },
    last(id) {
      if (pendingTail?.id === id) return pendingTail;
      const position = lastById.get(id);
      if (position === undefined) return undefined;
      if (position < length) return entries[position];
      // Superseded by an append after this snapshot: find the one it saw.
      for (let at = length - 1; at >= 0; at -= 1) {
        if (entries[at]!.id === id) return entries[at];
      }
      return undefined;
    },
  };
}

function lookupSnapshot(entries: readonly SessionIndexEntry[]): SessionIndexSnapshot {
  let lastById: Map<string, SessionIndexEntry> | undefined;
  return {
    entries: () => entries,
    last(id) {
      if (!lastById) {
        lastById = new Map();
        for (const entry of entries) lastById.set(entry.id, entry);
      }
      return lastById.get(id);
    },
  };
}

function sameStats(index: CachedSessionIndex, stats: BigIntStats): boolean {
  return (
    index.fileId === `${stats.dev}:${stats.ino}` &&
    Number(stats.size) === index.size &&
    stats.mtimeNs === index.mtimeNs &&
    stats.ctimeNs === index.ctimeNs
  );
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer | null> {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  counters.bytesRead += length;
  return buffer;
}

async function readAnchor(handle: FileHandle, end: number): Promise<Buffer | null> {
  return readRange(handle, Math.max(0, end - ANCHOR_BYTES), end);
}

/** A read that raced a truncation: nothing was installed. */
const RETRY = Symbol("retry");

async function fullRead(
  path: string,
  handle: FileHandle,
  stats: BigIntStats,
): Promise<SessionIndexSnapshot | typeof RETRY> {
  const size = Number(stats.size);
  const bytes = await readRange(handle, 0, size);
  if (!bytes) return RETRY;
  const { entries, committedBytes, pendingTail } = parseChunk(bytes);
  let estimatedBytes = INDEX_OVERHEAD_BYTES;
  for (const entry of entries) estimatedBytes += entryBytes(entry);
  if (pendingTail) estimatedBytes += entryBytes(pendingTail);
  if (!fitsAlone(entries.length, estimatedBytes)) {
    cache.delete(path);
    counters.uncachedReads += 1;
    return lookupSnapshot(pendingTail ? [...entries, pendingTail] : entries);
  }
  counters.fullReads += 1;
  const lastById = new Map<string, number>();
  entries.forEach((entry, position) => lastById.set(entry.id, position));
  const index: CachedSessionIndex = {
    path,
    fileId: `${stats.dev}:${stats.ino}`,
    size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    consumedEnd: committedBytes,
    // Copied so the cached anchor does not pin the whole file's buffer.
    anchor: Buffer.from(bytes.subarray(Math.max(0, committedBytes - ANCHOR_BYTES), committedBytes)),
    entries,
    lastById,
    ...(pendingTail ? { pendingTail } : {}),
    estimatedBytes,
  };
  touch(index);
  enforceBudgets();
  return snapshotOf(index);
}

/**
 * Extends `index` with the bytes appended since it was read. Returns `false`
 * when the growth cannot be trusted as an append, or the result would not fit.
 */
async function tailRead(
  index: CachedSessionIndex,
  handle: FileHandle,
  stats: BigIntStats,
): Promise<SessionIndexSnapshot | false> {
  const size = Number(stats.size);
  // Growth alone does not prove an append: the same inode may have been
  // rewritten with more bytes. Compare the bytes just before the boundary.
  const anchor = await readAnchor(handle, index.consumedEnd);
  if (!anchor?.equals(index.anchor)) return false;
  const bytes = await readRange(handle, index.consumedEnd, size);
  if (!bytes) return false;
  const { entries, committedBytes, pendingTail } = parseChunk(bytes);

  let estimatedBytes =
    index.estimatedBytes - (index.pendingTail ? entryBytes(index.pendingTail) : 0);
  for (const entry of entries) estimatedBytes += entryBytes(entry);
  if (pendingTail) estimatedBytes += entryBytes(pendingTail);
  if (!fitsAlone(index.entries.length + entries.length, estimatedBytes)) return false;

  counters.tailReads += 1;
  for (const entry of entries) {
    index.lastById.set(entry.id, index.entries.length);
    index.entries.push(entry);
  }
  if (committedBytes > 0) {
    const committed = bytes.subarray(0, committedBytes);
    // Copied so the cached anchor does not pin the whole tail buffer.
    index.anchor = Buffer.from(
      (committedBytes >= ANCHOR_BYTES
        ? committed
        : Buffer.concat([index.anchor, committed])
      ).subarray(-ANCHOR_BYTES),
    );
    index.consumedEnd += committedBytes;
  }
  index.pendingTail = pendingTail;
  index.size = size;
  index.mtimeNs = stats.mtimeNs;
  index.ctimeNs = stats.ctimeNs;
  index.estimatedBytes = estimatedBytes;
  touch(index);
  enforceBudgets();
  return snapshotOf(index);
}

async function refreshOnce(path: string): Promise<SessionIndexSnapshot | typeof RETRY> {
  const cached = cache.get(path);
  let pathStats: BigIntStats;
  try {
    pathStats = await stat(path, { bigint: true });
  } catch {
    // A missing index is the normal state of a fresh Codex home.
    cache.delete(path);
    return EMPTY_SNAPSHOT;
  }
  if (!pathStats.isFile()) {
    cache.delete(path);
    return EMPTY_SNAPSHOT;
  }
  if (cached && sameStats(cached, pathStats)) {
    touch(cached);
    return snapshotOf(cached);
  }

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    cache.delete(path);
    return EMPTY_SNAPSHOT;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const index = cache.get(path);
    if (index && sameStats(index, stats)) {
      touch(index);
      return snapshotOf(index);
    }
    if (index && index.fileId === `${stats.dev}:${stats.ino}` && Number(stats.size) > index.size) {
      const extended = await tailRead(index, handle, stats);
      if (extended) return extended;
    }
    cache.delete(path);
    return await fullRead(path, handle, stats);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function refreshLocked(path: string): Promise<SessionIndexSnapshot> {
  // One retry, for a file truncated while it was being read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const snapshot = await refreshOnce(path);
      if (snapshot !== RETRY) return snapshot;
    } catch {
      cache.delete(path);
      break;
    }
  }
  cache.delete(path);
  return uncachedRead(path);
}

/** The former whole-file read, for a file that keeps changing under the cache. */
async function uncachedRead(path: string): Promise<SessionIndexSnapshot> {
  counters.uncachedReads += 1;
  try {
    const raw = await readFile(path);
    counters.bytesRead += raw.length;
    const { entries, pendingTail } = parseChunk(raw);
    return lookupSnapshot(pendingTail ? [...entries, pendingTail] : entries);
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/**
 * The session index at `path` as it is now. Missing or unreadable reads as
 * empty: an absent index is the normal state for a fresh Codex home.
 */
export async function readSessionIndex(path: string): Promise<SessionIndexSnapshot> {
  const previous = locks.get(path) ?? Promise.resolve();
  const run = previous.then(
    () => refreshLocked(path),
    () => refreshLocked(path),
  );
  const settled = run.catch(() => undefined);
  locks.set(path, settled);
  try {
    return await run;
  } finally {
    if (locks.get(path) === settled) locks.delete(path);
  }
}
