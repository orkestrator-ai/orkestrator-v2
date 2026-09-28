import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import {
  MAX_ROLLOUT_RECORD_BYTES,
  ROLLOUT_CHUNK_BYTES,
  scanRolloutLines,
  type RolloutLine,
  type RolloutScanCursor,
  type RolloutScanLimits,
} from "./rollout-reader.js";
import {
  parseTranscriptRecordLine,
  type TranscriptReadStatus,
  type TranscriptRecord,
} from "./subagent-transcript.js";

/**
 * Rollout transcript cache: bounded parsing, block retention and folds.
 *
 * Rollouts are large — 30MB+ for a long conversation — and parsing one costs a
 * multiple of its size on the heap. Unbounded, a cache of parsed rollouts grew
 * to the size of the entire Codex history: measured at ~5.3GB of heap for a
 * 1.6GB store, retained for the life of the bridge.
 *
 * Consumers never receive "the whole rollout as an array". Each asks one of
 * three explicit query shapes (see `transcript-queries.ts` for who uses which):
 *
 * - `readTranscriptSince` — records at/after a timestamp plus the first
 *   `session_meta`. The live sub-agent render path asks this of the parent
 *   rollout on every render; the sparse block index skips every block whose
 *   newest timestamp predates the turn, so its cost is the turn, not the file.
 * - `foldTranscript` — an incremental reduction memoised per file generation.
 *   Child rollouts are folded once and then extended only by appended records.
 * - `acquireTranscriptSnapshot` + `forEachTranscriptBatch` — one complete
 *   chronological pass, for hydrating a thread on attach.
 *
 * Records are parsed by the bounded chunk reader in `rollout-reader.ts` into
 * immutable **blocks** of roughly `blockSourceBytes` of source. A block's index
 * entry (byte range, record ordinals, newest timestamp) is always retained; its
 * parsed records are retained only while the byte budget allows and are
 * re-read from their exact byte range otherwise. Appends add blocks instead of
 * copying a growing flat array.
 *
 * `readTranscriptHead` is separate and uncached: catalogue scans read only the
 * first 64 KiB of each rollout and never build an index.
 */

/**
 * Soft budget for **estimated retained heap** (not source bytes): idle entries
 * are shed beyond this.
 */
export const MAX_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Hard ceiling for estimated retained heap, even when every entry is in use.
 *
 * The soft budget alone caused pathological thrash: a working set larger than
 * the budget — one 70MB rollout, or a multi-agent turn whose parent and child
 * rollouts together exceed it — was evicted by its own insertion, so every
 * render tick of a streaming turn re-read and re-parsed tens of megabytes from
 * scratch. That allocation churn, at ~10 renders/second, is what ballooned the
 * bridge process to multi-GB RSS. An active working set stays resident up to
 * this ceiling; beyond it, the least recently used entries lose their oldest
 * record blocks first. Their block index and folds survive, so a rollout larger
 * than this ceiling keeps serving turn-range reads from its resident tail and
 * incremental folds from their memo — it never evicts itself wholesale.
 */
export const HARD_MAX_TRANSCRIPT_CACHE_BYTES = 256 * 1024 * 1024;

/** An entry read this recently is part of the active working set. */
const ACTIVE_TRANSCRIPT_GRACE_MS = 30_000;

/** Count bound for cached rollouts, including index-only entries. */
export const MAX_TRANSCRIPT_CACHE_ENTRIES = 64;

/**
 * Estimated retained heap per source byte of resident records.
 *
 * Measured with Bun on 12 local rollouts of 8–35 MiB: 1.91–1.96 bytes of heap
 * per source byte once parsed (JSC keeps most decoded strings as UTF-16). The
 * earlier whole-file cache cost ~3.3x including its duplicated raw lines. 3 is
 * deliberately above the measurement so record-dense rollouts are not
 * under-counted. It is an estimate, not a resident-heap limit.
 */
export const RETAINED_HEAP_BYTES_PER_SOURCE_BYTE = 3;

/** Target source bytes per record block: the unit of retention and re-reads. */
export const RECORD_BLOCK_SOURCE_BYTES = 256 * 1024;

/** Estimated heap of one block index entry (object + fields + array slot). */
const INDEX_BYTES_PER_BLOCK = 160;
/** Estimated heap of one entry apart from its blocks, memos and session_meta. */
const ENTRY_OVERHEAD_BYTES = 1024;
/** Bytes before the consumed boundary compared on append to detect rewrites. */
const ANCHOR_BYTES = 64;

/**
 * How much of a rollout to read when only its metadata is wanted.
 *
 * `session_meta` is the first record and the first user message follows shortly
 * after, so the head is enough to build a session-list entry. Reading whole files
 * for this is what made listing sessions load the entire history into memory.
 */
export const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

/** Record type of the marker that stands in for an unreadable rollout line. */
export const UNREADABLE_ROLLOUT_RECORD_TYPE = "orkestrator/unreadable-record";

export interface UnreadableRolloutRecord {
  reason: "overlong" | "corrupt";
  /** File byte offset where the unreadable line starts. */
  offset: number;
  /** Its length in bytes, including the newline. */
  bytes: number;
}

/**
 * The unreadable-line marker a record stands for, if it is one. Markers keep
 * their chronological position so a full replay can say where content is
 * missing; every other consumer ignores the unknown record type.
 */
export function unreadableRolloutRecord(
  record: TranscriptRecord,
): UnreadableRolloutRecord | undefined {
  if (record.type !== UNREADABLE_ROLLOUT_RECORD_TYPE || !record.payload) return undefined;
  const { reason, offset, bytes } = record.payload;
  return (reason === "overlong" || reason === "corrupt") &&
    typeof offset === "number" &&
    typeof bytes === "number"
    ? { reason, offset, bytes }
    : undefined;
}

interface TranscriptCacheLimits {
  softBudgetBytes: number;
  hardBudgetBytes: number;
  activeGraceMs: number;
  maxEntries: number;
  blockSourceBytes: number;
  maxRecordBytes: number;
  chunkBytes: number;
  retainedBytesPerSourceByte: number;
}

const DEFAULT_LIMITS: TranscriptCacheLimits = {
  softBudgetBytes: MAX_TRANSCRIPT_CACHE_BYTES,
  hardBudgetBytes: HARD_MAX_TRANSCRIPT_CACHE_BYTES,
  activeGraceMs: ACTIVE_TRANSCRIPT_GRACE_MS,
  maxEntries: MAX_TRANSCRIPT_CACHE_ENTRIES,
  blockSourceBytes: RECORD_BLOCK_SOURCE_BYTES,
  maxRecordBytes: MAX_ROLLOUT_RECORD_BYTES,
  chunkBytes: ROLLOUT_CHUNK_BYTES,
  retainedBytesPerSourceByte: RETAINED_HEAP_BYTES_PER_SOURCE_BYTE,
};

let limits: TranscriptCacheLimits = DEFAULT_LIMITS;

export function setTranscriptCacheLimitsForTesting(
  overrides?: Partial<TranscriptCacheLimits>,
): void {
  limits = { ...DEFAULT_LIMITS, ...overrides };
}

function scanLimits(): RolloutScanLimits {
  return { maxRecordBytes: limits.maxRecordBytes, chunkBytes: limits.chunkBytes };
}

interface RecordBlock {
  /** File byte offset of the block's first line. */
  readonly start: number;
  /** File byte offset just past the block's last newline. */
  readonly end: number;
  /** Ordinal (within this file generation) of the block's first record. */
  readonly firstOrdinal: number;
  readonly recordCount: number;
  /** Newest valid record timestamp; `-Infinity` when none has one. */
  readonly maxTimestampMs: number;
  /**
   * Parsed records while resident, `undefined` once shed. Residency is the only
   * mutable part of a block; readers capture the reference once per use.
   */
  records: readonly TranscriptRecord[] | undefined;
}

interface FoldMemo {
  /** Records of this generation already folded into `state`. */
  ordinal: number;
  state: unknown;
  estimatedBytes: number;
}

interface CachedTranscript {
  readonly path: string;
  /** `dev:ino` of the descriptor the bytes were read from. */
  readonly fileId: string;
  /** Rotates whenever the file is re-read from scratch. */
  readonly generation: number;
  /** The descriptor's fstat at the last read — never a later path stat. */
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  cursor: RolloutScanCursor;
  /** Offset just past the last complete line: where blocks end. */
  consumedEnd: number;
  /** The bytes immediately before `consumedEnd`, to detect a rewrite on growth. */
  anchor: Buffer;
  blocks: readonly RecordBlock[];
  recordCount: number;
  unreadableRecords: number;
  sessionMeta?: TranscriptRecord;
  sessionMetaBytes: number;
  residentBytes: number;
  memos: Map<string, FoldMemo>;
  lastAccessedAt: number;
}

/**
 * Cached rollouts keyed by path. `Map` iterates in insertion order and every
 * access re-inserts, so iteration is least-recently-used first.
 */
const transcriptCache = new Map<string, CachedTranscript>();

/** Estimated resident bytes of scans that have not been installed yet. */
let inFlightScanBytes = 0;
let nextGeneration = 1;

const counters = {
  coldScans: 0,
  appendScans: 0,
  blockRereads: 0,
  sourceBytesRead: 0,
};

function blockEstimatedBytes(block: { start: number; end: number }): number {
  return (block.end - block.start) * limits.retainedBytesPerSourceByte;
}

function memoBytes(entry: CachedTranscript): number {
  let total = 0;
  for (const memo of entry.memos.values()) total += memo.estimatedBytes;
  return total;
}

function entryEstimatedBytes(entry: CachedTranscript): number {
  return (
    ENTRY_OVERHEAD_BYTES +
    entry.blocks.length * INDEX_BYTES_PER_BLOCK +
    entry.sessionMetaBytes +
    entry.residentBytes +
    memoBytes(entry)
  );
}

function totalEstimatedBytes(): number {
  let total = 0;
  for (const entry of transcriptCache.values()) total += entryEstimatedBytes(entry);
  return total;
}

export interface TranscriptCacheStats {
  entries: number;
  /** Estimated retained heap of everything cached (the budgeted quantity). */
  bytes: number;
  /** Source bytes covered by cached entries, resident or not. */
  sourceBytes: number;
  /** Source bytes whose parsed records are resident. */
  residentSourceBytes: number;
  indexBlocks: number;
  residentBlocks: number;
  memoBytes: number;
  coldScans: number;
  appendScans: number;
  blockRereads: number;
  sourceBytesRead: number;
}

export function getTranscriptCacheStats(): TranscriptCacheStats {
  let sourceBytes = 0;
  let residentSourceBytes = 0;
  let indexBlocks = 0;
  let residentBlocks = 0;
  let memos = 0;
  for (const entry of transcriptCache.values()) {
    sourceBytes += entry.consumedEnd;
    indexBlocks += entry.blocks.length;
    memos += memoBytes(entry);
    for (const block of entry.blocks) {
      if (!block.records) continue;
      residentBlocks += 1;
      residentSourceBytes += block.end - block.start;
    }
  }
  return {
    entries: transcriptCache.size,
    bytes: totalEstimatedBytes(),
    sourceBytes,
    residentSourceBytes,
    indexBlocks,
    residentBlocks,
    memoBytes: memos,
    ...counters,
  };
}

export function clearTranscriptCache(): void {
  transcriptCache.clear();
  counters.coldScans = 0;
  counters.appendScans = 0;
  counters.blockRereads = 0;
  counters.sourceBytesRead = 0;
}

function touch(entry: CachedTranscript): void {
  entry.lastAccessedAt = Date.now();
  // Delete before set so the re-inserted entry moves to the newest position.
  transcriptCache.delete(entry.path);
  transcriptCache.set(entry.path, entry);
}

function dropEntry(path: string): void {
  transcriptCache.delete(path);
}

/** Sheds up to `excess` estimated bytes from one entry; returns bytes shed. */
function shedEntry(entry: CachedTranscript, excess: number, dropIndex: boolean): number {
  let shed = 0;
  // Oldest blocks first: the tail is what live turn-range reads ask for.
  for (const block of entry.blocks) {
    if (shed >= excess) return shed;
    if (!block.records) continue;
    block.records = undefined;
    const bytes = blockEstimatedBytes(block);
    entry.residentBytes -= bytes;
    shed += bytes;
  }
  for (const [key, memo] of entry.memos) {
    if (shed >= excess) return shed;
    entry.memos.delete(key);
    shed += memo.estimatedBytes;
  }
  if (shed < excess && dropIndex) {
    shed += entryEstimatedBytes(entry);
    dropEntry(entry.path);
  }
  return shed;
}

/**
 * Keeps the cache within its count and byte budgets.
 *
 * Least-recently-used entries are shed first. Idle entries are shed down to the
 * soft budget; entries read within the grace window are protected up to the
 * hard ceiling, because evicting an active working set recreates the
 * re-read-per-tick thrash the ceiling exists to stop. An active entry is shed
 * block-by-block and keeps its index, so even an entry that alone exceeds the
 * ceiling stays usable without a full re-scan.
 */
function enforceBudgets(): void {
  while (transcriptCache.size > limits.maxEntries) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest === undefined) break;
    dropEntry(oldest);
  }

  const now = Date.now();
  let total = totalEstimatedBytes();
  // `shedEntry` may delete the entry being visited; Map iteration tolerates that.
  for (const entry of transcriptCache.values()) {
    if (total <= limits.softBudgetBytes) return;
    const active = now - entry.lastAccessedAt < limits.activeGraceMs;
    const target = active ? limits.hardBudgetBytes : limits.softBudgetBytes;
    // Entries iterate least-recently-used first, so if even this one is active
    // and within the ceiling, everything behind it is too.
    if (total <= target) return;
    total -= shedEntry(entry, total - target, !active);
  }

  // Only indexes and the newest entries remain and the ceiling still does not
  // hold: drop whole entries, oldest first. Unreachable in practice — an index
  // costs ~0.06% of its source — but the ceiling is a guarantee.
  for (const entry of transcriptCache.values()) {
    if (total <= limits.hardBudgetBytes) return;
    total -= shedEntry(entry, Number.POSITIVE_INFINITY, true);
  }
}

// --- Scanning --------------------------------------------------------------

function timestampMs(record: TranscriptRecord): number {
  if (!record.timestamp) return Number.NaN;
  return new Date(record.timestamp).getTime();
}

function unreadableMarker(
  reason: UnreadableRolloutRecord["reason"],
  start: number,
  end: number,
): TranscriptRecord {
  return {
    type: UNREADABLE_ROLLOUT_RECORD_TYPE,
    payload: { reason, offset: start, bytes: end - start },
  };
}

/** Converts one scanned line into a record, a marker, or nothing (blank line). */
function recordFromLine(line: RolloutLine): TranscriptRecord | null {
  if (line.kind === "overlong") return unreadableMarker("overlong", line.start, line.end);
  const text = line.text.trim();
  if (!text) return null;
  return parseTranscriptRecordLine(text) ?? unreadableMarker("corrupt", line.start, line.end);
}

/**
 * Accumulates scanned lines into sealed blocks, bounding how many of them stay
 * resident while the scan is still running.
 */
class BlockBuilder {
  readonly blocks: RecordBlock[];
  private records: TranscriptRecord[] = [];
  private start: number;
  private end: number;
  private firstOrdinal: number;
  private maxTimestampMs = Number.NEGATIVE_INFINITY;
  ordinal: number;
  unreadableRecords = 0;
  sessionMeta?: TranscriptRecord;
  sessionMetaBytes = 0;
  /** Estimated bytes of this scan's resident blocks, counted in `inFlightScanBytes`. */
  private residentBytes = 0;
  private residentFrom = 0;

  constructor(
    base: readonly RecordBlock[],
    reopen: RecordBlock | undefined,
    from: number,
    ordinal: number,
  ) {
    this.blocks = [...base];
    this.residentFrom = this.blocks.length;
    this.start = reopen?.start ?? from;
    this.end = from;
    this.firstOrdinal = reopen?.firstOrdinal ?? ordinal;
    this.ordinal = ordinal;
    if (reopen?.records) {
      // Bounded copy: a reopened block is below `blockSourceBytes`.
      this.records = [...reopen.records];
      this.maxTimestampMs = reopen.maxTimestampMs;
    }
  }

  /** Whether this scan produced any complete line (a reopened block alone does not count). */
  sawLines = false;

  accept(lines: RolloutLine[]): void {
    for (const line of lines) {
      this.sawLines = true;
      this.end = line.end;
      const record = recordFromLine(line);
      if (record) {
        this.records.push(record);
        this.ordinal += 1;
        if (record.type === UNREADABLE_ROLLOUT_RECORD_TYPE) this.unreadableRecords += 1;
        if (record.type === "session_meta" && !this.sessionMeta && line.kind === "line") {
          this.sessionMeta = record;
          this.sessionMetaBytes = (line.end - line.start) * limits.retainedBytesPerSourceByte;
        }
        const ms = timestampMs(record);
        if (ms > this.maxTimestampMs) this.maxTimestampMs = ms;
      }
      if (this.end - this.start >= limits.blockSourceBytes) this.seal();
    }
  }

  /** Whether the builder holds lines not yet sealed into a block. */
  get pending(): boolean {
    return this.end > this.start;
  }

  seal(): void {
    if (!this.pending) return;
    const block: RecordBlock = {
      start: this.start,
      end: this.end,
      firstOrdinal: this.firstOrdinal,
      recordCount: this.records.length,
      maxTimestampMs: this.maxTimestampMs,
      records: this.records,
    };
    this.blocks.push(block);
    const bytes = blockEstimatedBytes(block);
    this.residentBytes += bytes;
    inFlightScanBytes += bytes;
    this.start = this.end;
    this.firstOrdinal = this.ordinal;
    this.records = [];
    this.maxTimestampMs = Number.NEGATIVE_INFINITY;
    // Bound a cold scan's peak: its own resident blocks, and all scans still
    // in flight together, stay under the hard ceiling. The oldest go first.
    while (
      (this.residentBytes > limits.hardBudgetBytes || inFlightScanBytes > limits.hardBudgetBytes) &&
      this.residentFrom < this.blocks.length
    ) {
      const oldest = this.blocks[this.residentFrom]!;
      this.residentFrom += 1;
      if (!oldest.records) continue;
      oldest.records = undefined;
      const shed = blockEstimatedBytes(oldest);
      this.residentBytes -= shed;
      inFlightScanBytes -= shed;
    }
  }

  /** Hands residency accounting from the in-flight pool to the entry. */
  release(): number {
    inFlightScanBytes -= this.residentBytes;
    const bytes = this.residentBytes;
    this.residentBytes = 0;
    return bytes;
  }
}

function sameStats(
  entry: CachedTranscript,
  fileId: string,
  stats: Pick<BigIntStats, "size" | "mtimeNs" | "ctimeNs">,
): boolean {
  return (
    entry.fileId === fileId &&
    Number(stats.size) === entry.size &&
    stats.mtimeNs === entry.mtimeNs &&
    stats.ctimeNs === entry.ctimeNs
  );
}

function consumedEndOf(cursor: RolloutScanCursor): number {
  return cursor.overlongFrom ?? cursor.offset;
}

async function readAnchor(handle: FileHandle, end: number): Promise<Buffer> {
  const length = Math.min(ANCHOR_BYTES, end);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, end - length);
  return buffer.subarray(0, bytesRead);
}

/** A read that raced a truncation: nothing was installed; read again. */
const RETRY = Symbol("retry");

async function coldScan(
  path: string,
  handle: FileHandle,
  stats: BigIntStats,
): Promise<CachedTranscript | typeof RETRY> {
  counters.coldScans += 1;
  const size = Number(stats.size);
  const builder = new BlockBuilder([], undefined, 0, 0);
  let installed = false;
  try {
    const result = await scanRolloutLines(handle, { offset: 0 }, size, scanLimits(), (lines) =>
      builder.accept(lines),
    );
    counters.sourceBytesRead += result.bytesRead;
    // Truncated while being read: these bytes may mix two versions of the file.
    if (result.shortRead) return RETRY;
    builder.seal();
    const consumedEnd = consumedEndOf(result.cursor);
    const entry: CachedTranscript = {
      path,
      fileId: `${stats.dev}:${stats.ino}`,
      generation: nextGeneration++,
      size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      cursor: result.cursor,
      consumedEnd,
      anchor: await readAnchor(handle, consumedEnd),
      blocks: builder.blocks,
      recordCount: builder.ordinal,
      unreadableRecords: builder.unreadableRecords,
      sessionMeta: builder.sessionMeta,
      sessionMetaBytes: builder.sessionMetaBytes,
      residentBytes: builder.release(),
      memos: new Map(),
      lastAccessedAt: Date.now(),
    };
    installed = true;
    transcriptCache.set(path, entry);
    touch(entry);
    enforceBudgets();
    return entry;
  } finally {
    if (!installed) builder.release();
  }
}

/**
 * Extends `entry` with the bytes appended since it was read. Returns `false`
 * when the append cannot be trusted and the file must be re-read from scratch.
 */
async function appendScan(
  entry: CachedTranscript,
  handle: FileHandle,
  stats: BigIntStats,
): Promise<boolean> {
  // Growth alone does not prove an append: the same inode may have been
  // rewritten with more bytes. Compare the bytes just before the boundary.
  const anchor = await readAnchor(handle, entry.consumedEnd);
  if (!anchor.equals(entry.anchor)) return false;

  counters.appendScans += 1;
  const size = Number(stats.size);
  const last = entry.blocks.at(-1);
  const reopen =
    last?.records && last.end - last.start < limits.blockSourceBytes ? last : undefined;
  const builder = new BlockBuilder(
    reopen ? entry.blocks.slice(0, -1) : entry.blocks,
    reopen,
    entry.consumedEnd,
    entry.recordCount,
  );
  let installed = false;
  try {
    const result = await scanRolloutLines(handle, entry.cursor, size, scanLimits(), (lines) =>
      builder.accept(lines),
    );
    counters.sourceBytesRead += result.bytesRead;
    if (result.shortRead) return false;
    // The entry may have been dropped or replaced while this scan awaited.
    if (transcriptCache.get(entry.path) !== entry) return false;

    const consumedEnd = consumedEndOf(result.cursor);
    if (builder.sawLines) {
      builder.seal();
      // The merged block replaces the reopened one. If eviction shed the
      // reopened block while this scan awaited, its bytes were already
      // released; the builder kept its own copy of the records.
      if (reopen?.records) {
        reopen.records = undefined;
        entry.residentBytes -= blockEstimatedBytes(reopen);
      }
      entry.blocks = builder.blocks;
      entry.recordCount = builder.ordinal;
      entry.unreadableRecords += builder.unreadableRecords;
      if (!entry.sessionMeta && builder.sessionMeta) {
        entry.sessionMeta = builder.sessionMeta;
        entry.sessionMetaBytes = builder.sessionMetaBytes;
      }
      entry.residentBytes += builder.release();
    }
    installed = true;
    entry.cursor = result.cursor;
    if (consumedEnd !== entry.consumedEnd) {
      entry.consumedEnd = consumedEnd;
      entry.anchor = await readAnchor(handle, consumedEnd);
    }
    entry.size = size;
    entry.mtimeNs = stats.mtimeNs;
    entry.ctimeNs = stats.ctimeNs;
    touch(entry);
    enforceBudgets();
    return true;
  } finally {
    if (!installed) builder.release();
  }
}

/**
 * Brings the cached entry for `path` up to date. Must run under the path lock.
 *
 * The descriptor is opened first and every size/identity used to label the
 * parsed bytes comes from `fstat` of that same descriptor, so bytes read from
 * one file are never attributed to a replacement that appeared at the path
 * afterwards. Returns `undefined` when the file cannot be read.
 */
async function refreshLocked(path: string): Promise<CachedTranscript | undefined> {
  // One retry, for a file truncated or rewritten while it was being read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refreshed = await refreshOnce(path);
    if (refreshed !== RETRY) return refreshed;
  }
  return undefined;
}

async function refreshOnce(path: string): Promise<CachedTranscript | undefined | typeof RETRY> {
  const cached = transcriptCache.get(path);
  let pathStats: BigIntStats;
  try {
    pathStats = await stat(path, { bigint: true });
  } catch {
    dropEntry(path);
    return undefined;
  }
  if (cached && sameStats(cached, `${pathStats.dev}:${pathStats.ino}`, pathStats)) {
    // Unchanged: no bytes are read, so nothing needs a descriptor's identity.
    touch(cached);
    return cached;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stats = await handle.stat({ bigint: true });
    const fileId = `${stats.dev}:${stats.ino}`;
    const current = transcriptCache.get(path);
    if (current && sameStats(current, fileId, stats)) {
      touch(current);
      return current;
    }
    const size = Number(stats.size);
    if (
      current &&
      current.fileId === fileId &&
      size > current.size &&
      (await appendScan(current, handle, stats))
    ) {
      return current;
    }
    // Replaced inode, shrink, same-size rewrite, or an untrustworthy append:
    // a new generation, so folds and block offsets of the old one are dropped.
    dropEntry(path);
    return await coldScan(path, handle, stats);
  } catch {
    dropEntry(path);
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// --- Per-path serialisation -----------------------------------------------

const pathLocks = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task for the same path.
 *
 * This is both the in-flight sharing and the install ordering: concurrent
 * readers of one rollout queue behind the first, which does the source read;
 * the rest find the entry current and read nothing. Appends are installed one
 * at a time, so an older scan can never install after a newer one. The chain
 * never rejects, and one waiter giving up cannot abort a scan other waiters
 * still need — there is no cancellation of the shared work.
 */
async function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  pathLocks.set(path, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pathLocks.get(path) === tail) pathLocks.delete(path);
  }
}

// --- Snapshots and block reads --------------------------------------------

/** A consistent, immutable view of one rollout generation. */
export interface TranscriptSnapshot {
  readonly path: string;
  readonly fileId: string;
  readonly generation: number;
  /** Source bytes covered by `blocks` (up to the last complete line). */
  readonly sourceBytes: number;
  readonly recordCount: number;
  readonly unreadableRecords: number;
  /** The first `session_meta` record, whatever block it lives in. */
  readonly sessionMeta?: TranscriptRecord;
  /**
   * `complete`: every line parsed. `degraded`: some lines are unreadable and
   * stand as markers. `unavailable`: the file could not be read at all — which
   * is not the same as a rollout with no records.
   */
  readonly status: TranscriptReadStatus;
  readonly blocks: readonly RecordBlock[];
}

function snapshotOf(entry: CachedTranscript): TranscriptSnapshot {
  return {
    path: entry.path,
    fileId: entry.fileId,
    generation: entry.generation,
    sourceBytes: entry.consumedEnd,
    recordCount: entry.recordCount,
    unreadableRecords: entry.unreadableRecords,
    sessionMeta: entry.sessionMeta,
    status: entry.unreadableRecords > 0 ? "degraded" : "complete",
    blocks: entry.blocks,
  };
}

function unavailableSnapshot(path: string): TranscriptSnapshot {
  return {
    path,
    fileId: "",
    generation: 0,
    sourceBytes: 0,
    recordCount: 0,
    unreadableRecords: 0,
    status: "unavailable",
    blocks: [],
  };
}

/** Refreshes `path` (sharing any in-flight read) and returns a snapshot of it. */
export async function acquireTranscriptSnapshot(path: string): Promise<TranscriptSnapshot> {
  return withPathLock(path, async () => {
    const entry = await refreshLocked(path);
    return entry ? snapshotOf(entry) : unavailableSnapshot(path);
  });
}

/**
 * Serves a snapshot's blocks, re-reading shed ones from their exact byte range.
 *
 * One descriptor per reader, checked once against the snapshot's identity. A
 * re-read that does not reproduce the block (wrong inode, truncated, different
 * record count) returns `null`: the snapshot is stale and the caller retries
 * from a fresh one rather than mixing two versions of the file.
 */
class SnapshotBlockReader {
  private handle: FileHandle | undefined;
  private opened = false;

  constructor(private readonly snapshot: TranscriptSnapshot) {}

  async read(block: RecordBlock, admit: boolean): Promise<readonly TranscriptRecord[] | null> {
    const resident = block.records;
    if (resident) return resident;
    if (!this.opened) {
      this.opened = true;
      try {
        this.handle = await open(this.snapshot.path, "r");
        const stats = await this.handle.stat({ bigint: true });
        if (`${stats.dev}:${stats.ino}` !== this.snapshot.fileId) await this.close();
      } catch {
        await this.close();
      }
    }
    if (!this.handle) return null;

    counters.blockRereads += 1;
    const records: TranscriptRecord[] = [];
    let result;
    try {
      result = await scanRolloutLines(
        this.handle,
        { offset: block.start },
        block.end,
        scanLimits(),
        (lines) => {
          for (const line of lines) {
            const record = recordFromLine(line);
            if (record) records.push(record);
          }
        },
      );
    } catch {
      return null;
    }
    counters.sourceBytesRead += result.bytesRead;
    if (
      result.shortRead ||
      result.cursor.overlongFrom !== undefined ||
      result.cursor.offset !== block.end ||
      records.length !== block.recordCount
    ) {
      return null;
    }
    if (admit) this.admit(block, records);
    return records;
  }

  /** Makes a re-read block resident again if it still belongs to the live entry. */
  private admit(block: RecordBlock, records: readonly TranscriptRecord[]): void {
    const entry = transcriptCache.get(this.snapshot.path);
    if (!entry || entry.generation !== this.snapshot.generation || block.records) return;
    if (!entry.blocks.includes(block)) return;
    block.records = records;
    entry.residentBytes += blockEstimatedBytes(block);
    touch(entry);
    enforceBudgets();
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close().catch(() => undefined);
  }
}

function invalidate(path: string, generation: number): void {
  if (transcriptCache.get(path)?.generation === generation) dropEntry(path);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Records a full replay visits between event-loop yields. */
const RECORDS_PER_REPLAY_YIELD = 2048;

/**
 * Visits every record of `snapshot` in file order, one block at a time.
 *
 * Shed blocks are re-read transiently (not re-admitted), so a full pass over a
 * rollout larger than the cache retains at most one block of records beyond
 * what the visitor keeps. Returns `false` if the file changed underneath the
 * snapshot; the caller must restart from a fresh snapshot.
 */
export async function forEachTranscriptBatch(
  snapshot: TranscriptSnapshot,
  visit: (records: readonly TranscriptRecord[]) => void,
): Promise<boolean> {
  const reader = new SnapshotBlockReader(snapshot);
  let visitedSinceYield = 0;
  try {
    for (const block of snapshot.blocks) {
      const resident = block.records;
      const records = resident ?? (await reader.read(block, false));
      if (!records) {
        invalidate(snapshot.path, snapshot.generation);
        return false;
      }
      visit(records);
      // Resident blocks cost no I/O but still cost the visitor's CPU; a long
      // replay must not hold the event loop for the whole rollout.
      visitedSinceYield += records.length;
      if (!resident || visitedSinceYield >= RECORDS_PER_REPLAY_YIELD) {
        visitedSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    return true;
  } finally {
    await reader.close();
  }
}

// --- Query: records since a timestamp --------------------------------------

export interface TranscriptRangeResult {
  /** Records whose timestamp is valid and at or after `sinceMs`, in file order. */
  records: TranscriptRecord[];
  sessionMeta?: TranscriptRecord;
  status: TranscriptReadStatus;
}

/**
 * Records at or after `sinceMs` — exactly `records.filter(ts >= sinceMs)` over
 * the whole rollout, but blocks whose newest timestamp is older are skipped
 * without being read, so a live turn costs the turn rather than the file.
 */
export async function readTranscriptSince(
  path: string,
  sinceMs: number,
): Promise<TranscriptRangeResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await acquireTranscriptSnapshot(path);
    if (snapshot.status === "unavailable") return { records: [], status: "unavailable" };
    const reader = new SnapshotBlockReader(snapshot);
    try {
      const records: TranscriptRecord[] = [];
      let stale = false;
      for (const block of snapshot.blocks) {
        if (!(block.maxTimestampMs >= sinceMs)) continue;
        const blockRecords = await reader.read(block, true);
        if (!blockRecords) {
          stale = true;
          break;
        }
        for (const record of blockRecords) {
          if (timestampMs(record) >= sinceMs) records.push(record);
        }
      }
      if (!stale) {
        return { records, sessionMeta: snapshot.sessionMeta, status: snapshot.status };
      }
      invalidate(path, snapshot.generation);
    } finally {
      await reader.close();
    }
  }
  return { records: [], status: "unavailable" };
}

// --- Query: incremental fold -----------------------------------------------

/**
 * A left fold over a rollout's records, memoised per file generation.
 *
 * `step` may mutate `state`; `result` must return a value that later steps
 * cannot change. The memo is extended with appended records only, and dropped
 * with the generation when the file is replaced or rewritten.
 */
export interface TranscriptReducer<State, Result> {
  readonly key: string;
  init(): State;
  step(state: State, record: TranscriptRecord): void;
  result(state: State, status: TranscriptReadStatus): Result;
  estimateBytes(state: State): number;
}

export async function foldTranscript<State, Result>(
  path: string,
  reducer: TranscriptReducer<State, Result>,
): Promise<Result> {
  return withPathLock(path, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = await refreshLocked(path);
      if (!entry) return reducer.result(reducer.init(), "unavailable");
      const existing = entry.memos.get(reducer.key);
      const memo: FoldMemo = existing ?? { ordinal: 0, state: reducer.init(), estimatedBytes: 0 };
      const state = memo.state as State;
      const snapshot = snapshotOf(entry);
      const reader = new SnapshotBlockReader(snapshot);
      let stale = false;
      try {
        for (const block of snapshot.blocks) {
          if (block.firstOrdinal + block.recordCount <= memo.ordinal) continue;
          const records = await reader.read(block, false);
          if (!records) {
            stale = true;
            break;
          }
          for (let index = memo.ordinal - block.firstOrdinal; index < records.length; index += 1) {
            reducer.step(state, records[index]!);
            memo.ordinal += 1;
          }
        }
      } catch (error) {
        // A step that threw left the state half-applied; never reuse it.
        entry.memos.delete(reducer.key);
        throw error;
      } finally {
        await reader.close();
      }
      if (stale) {
        invalidate(path, snapshot.generation);
        continue;
      }
      if (transcriptCache.get(path) === entry) {
        memo.estimatedBytes = reducer.estimateBytes(state);
        entry.memos.set(reducer.key, memo);
        enforceBudgets();
      }
      return reducer.result(state, snapshot.status);
    }
    return reducer.result(reducer.init(), "unavailable");
  });
}

// --- Catalogue head reads --------------------------------------------------

/**
 * Reads only the head of a rollout and parses the records found there.
 *
 * For building a session-list entry we need `session_meta` (id, cwd, timestamp)
 * and the first user message (fallback title) — both near the start. Reading the
 * whole file to find them is what made listing sessions pull the entire Codex
 * history into memory.
 *
 * Deliberately **not** cached and never indexed: metadata scans touch every
 * rollout on disk, so caching them is exactly the unbounded growth this avoids.
 * The head is cheap to re-read.
 */
export async function readTranscriptHead(
  path: string,
  maxBytes: number = TRANSCRIPT_HEAD_BYTES,
): Promise<{ records: TranscriptRecord[]; truncated: boolean }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const size = (await handle.stat()).size;
    const records: TranscriptRecord[] = [];
    // A trailing partial line is left unconsumed: parsing half a JSON record
    // would throw.
    await scanRolloutLines(
      handle,
      { offset: 0 },
      Math.min(maxBytes, size),
      { maxRecordBytes: maxBytes, chunkBytes: maxBytes },
      (lines) => {
        for (const line of lines) {
          if (line.kind !== "line") continue;
          const text = line.text.trim();
          const record = text ? parseTranscriptRecordLine(text) : null;
          if (record) records.push(record);
        }
      },
    );
    return { records, truncated: size > maxBytes };
  } catch {
    return { records: [], truncated: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
