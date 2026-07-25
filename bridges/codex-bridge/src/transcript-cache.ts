import { open, readFile, stat } from "node:fs/promises";
import {
  parseTranscriptRecords,
  type TranscriptRecord,
} from "./subagent-transcript.js";

interface CachedTranscript {
  fileId: string;
  size: number;
  modifiedAtNs: string;
  remainder: string;
  lines: string[];
  records: TranscriptRecord[];
}

/**
 * Full-transcript cache, bounded by retained bytes.
 *
 * Rollouts are large — 30MB+ for a long conversation — and parsing one into
 * `lines` plus `records` costs roughly 4x its size on the heap. Unbounded, this
 * map grew to the size of the entire Codex history: measured at ~5.3GB of heap
 * for a 1.6GB store, retained for the life of the bridge.
 *
 * `Map` iterates in insertion order, and `readCachedTranscript` re-inserts on
 * every hit, so evicting the first key is an LRU eviction.
 */
const transcriptCache = new Map<string, CachedTranscript>();

/** Heap cost is ~4x the on-disk bytes, so this is roughly 256MB of heap. */
export const MAX_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * How much of a rollout to read when only its metadata is wanted.
 *
 * `session_meta` is the first record and the first user message follows shortly
 * after, so the head is enough to build a session-list entry. Reading whole files
 * for this is what made listing sessions load the entire history into memory.
 */
export const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

let cachedBytes = 0;

function evictTranscriptCache(): void {
  while (cachedBytes > MAX_TRANSCRIPT_CACHE_BYTES) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = transcriptCache.get(oldest);
    transcriptCache.delete(oldest);
    cachedBytes -= evicted?.size ?? 0;
  }
  if (cachedBytes < 0) cachedBytes = 0;
}

function storeTranscript(path: string, transcript: CachedTranscript): void {
  const previous = transcriptCache.get(path);
  if (previous) cachedBytes -= previous.size;
  // Delete before set so the re-inserted entry moves to the newest position.
  transcriptCache.delete(path);
  transcriptCache.set(path, transcript);
  cachedBytes += transcript.size;
  evictTranscriptCache();
}

export function getTranscriptCacheStats(): { entries: number; bytes: number } {
  return { entries: transcriptCache.size, bytes: cachedBytes };
}

function normalizeTranscriptLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function splitTranscriptChunk(
  chunk: string,
  remainder: string,
): { lines: string[]; remainder: string } {
  if (!chunk && !remainder) {
    return { lines: [], remainder: "" };
  }

  const combined = `${remainder}${chunk}`;
  const rawLines = combined.split("\n");
  const trailingRemainder = combined.endsWith("\n") ? "" : (rawLines.pop() ?? "");

  return {
    lines: normalizeTranscriptLines(rawLines),
    remainder: trailingRemainder,
  };
}

async function readTranscriptChunk(
  path: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) {
    return "";
  }

  const handle = await open(path, "r");
  try {
    let remaining = length;
    let position = start;
    const chunks: Buffer[] = [];

    while (remaining > 0) {
      const buffer = Buffer.alloc(Math.min(remaining, 64 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadTranscriptFromScratch(path: string): Promise<CachedTranscript> {
  const raw = await readFile(path, "utf8");
  const stats = await stat(path, { bigint: true });
  const { lines, remainder } = splitTranscriptChunk(raw, "");
  return {
    fileId: `${stats.dev}:${stats.ino}`,
    size: Buffer.byteLength(raw, "utf8"),
    modifiedAtNs: stats.mtimeNs.toString(),
    remainder,
    lines,
    records: parseTranscriptRecords(lines),
  };
}

export async function readCachedTranscript(path: string): Promise<CachedTranscript> {
  try {
    const stats = await stat(path, { bigint: true });
    const fileId = `${stats.dev}:${stats.ino}`;
    const size = Number(stats.size);
    const modifiedAtNs = stats.mtimeNs.toString();
    const cached = transcriptCache.get(path);

    if (
      !cached ||
      fileId !== cached.fileId ||
      size < cached.size ||
      (size === cached.size && modifiedAtNs !== cached.modifiedAtNs)
    ) {
      const loaded = await loadTranscriptFromScratch(path);
      storeTranscript(path, loaded);
      return loaded;
    }

    if (size === cached.size) {
      // Re-insert so a repeatedly-read transcript is not evicted before a
      // transcript nobody has touched since startup.
      storeTranscript(path, cached);
      return cached;
    }

    const appendedChunk = await readTranscriptChunk(path, cached.size, size - cached.size);
    const { lines: appendedLines, remainder } = splitTranscriptChunk(
      appendedChunk,
      cached.remainder,
    );
    const next: CachedTranscript = {
      fileId,
      size,
      modifiedAtNs,
      remainder,
      lines: appendedLines.length > 0 ? [...cached.lines, ...appendedLines] : cached.lines,
      records:
        appendedLines.length > 0
          ? [...cached.records, ...parseTranscriptRecords(appendedLines)]
          : cached.records,
    };
    storeTranscript(path, next);
    return next;
  } catch {
    const dropped = transcriptCache.get(path);
    transcriptCache.delete(path);
    cachedBytes -= dropped?.size ?? 0;
    if (cachedBytes < 0) cachedBytes = 0;
    return {
      fileId: "",
      size: 0,
      modifiedAtNs: "0",
      remainder: "",
      lines: [],
      records: [],
    };
  }
}

export function clearTranscriptCache(): void {
  transcriptCache.clear();
  cachedBytes = 0;
}

/**
 * Reads only the head of a rollout and parses the records found there.
 *
 * For building a session-list entry we need `session_meta` (id, cwd, timestamp)
 * and the first user message (fallback title) — both near the start. Reading the
 * whole file to find them is what made listing sessions pull the entire Codex
 * history into memory.
 *
 * Deliberately **not** cached: metadata scans touch every rollout on disk, so
 * caching them is exactly the unbounded growth this avoids. The head is cheap to
 * re-read.
 */
export async function readTranscriptHead(
  path: string,
  maxBytes: number = TRANSCRIPT_HEAD_BYTES,
): Promise<{ records: TranscriptRecord[]; truncated: boolean }> {
  try {
    const stats = await stat(path);
    const head = await readTranscriptChunk(path, 0, Math.min(maxBytes, Number(stats.size)));
    // Drop a trailing partial line: parsing half a JSON record would throw.
    const { lines } = splitTranscriptChunk(head, "");
    return {
      records: parseTranscriptRecords(lines),
      truncated: Number(stats.size) > maxBytes,
    };
  } catch {
    return { records: [], truncated: false };
  }
}
