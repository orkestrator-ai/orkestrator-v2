/**
 * Bounded JSONL scanning for Codex rollout files.
 *
 * Rollouts are append-only JSONL written by Codex. A long conversation is tens
 * of megabytes and individual records (inline base64 screenshots, large tool
 * outputs) reach several megabytes — 4.2 MiB was the largest line in a local
 * sample of 100 rollouts. Reading a whole file with `readFile` and splitting it
 * allocated the entire file as one string, then again as an array of lines,
 * before a single record was parsed.
 *
 * This scanner reads fixed-size chunks from an already-open file descriptor and
 * splits on the newline **byte**. UTF-8 never encodes 0x0A inside a multi-byte
 * sequence, so a line boundary found in bytes is always a character boundary:
 * a code point split across two chunks is carried as raw bytes and decoded once
 * the whole line is present. That is the incremental decoding — no decoder
 * state has to survive between chunks or between appends, and every offset
 * reported is a file byte offset.
 *
 * Only one incomplete line is ever carried, and only up to `maxRecordBytes`.
 * A line longer than that is discarded as it streams past and reported as an
 * `overlong` line with its byte range, never allocated whole.
 */
import type { FileHandle } from "node:fs/promises";

/**
 * Largest single rollout line that is decoded and parsed.
 *
 * Four times the largest line observed locally, so real screenshots and tool
 * outputs parse; a pathological line beyond it becomes an explicit unreadable
 * marker instead of an unbounded allocation. Peak transient cost of one line at
 * this cap is roughly twice the cap (the joined bytes plus the decoded string).
 */
export const MAX_ROLLOUT_RECORD_BYTES = 16 * 1024 * 1024;

/** Bytes per `read()`; also the unit of parse work between event-loop yields. */
export const ROLLOUT_CHUNK_BYTES = 256 * 1024;

export interface RolloutScanLimits {
  maxRecordBytes: number;
  chunkBytes: number;
}

/** Where a scan resumes. All offsets are file bytes. */
export interface RolloutScanCursor {
  /**
   * First byte not yet consumed into a complete line. In normal mode this is
   * the start of the incomplete trailing line, which is re-read (at most
   * `maxRecordBytes`) when the file grows rather than retained between reads.
   */
  offset: number;
  /**
   * Set while an overlong line is being discarded: the byte where it began.
   * `offset` is then how far the discard has already scanned.
   */
  overlongFrom?: number;
}

export type RolloutLine =
  /** `end` is the offset just past the terminating newline. */
  | { kind: "line"; text: string; start: number; end: number }
  | { kind: "overlong"; start: number; end: number };

export interface RolloutScanResult {
  cursor: RolloutScanCursor;
  bytesRead: number;
  /** The file ended before `end`: it was truncated while being read. */
  shortRead: boolean;
}

const NEWLINE = 0x0a;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Scans `[cursor, end)` of `handle`, handing complete lines to `onLines` one
 * chunk at a time. An incomplete final line is left for the next scan; its
 * start is the returned cursor. Yields to the event loop between chunks so a
 * cold scan of a large rollout never monopolises the bridge.
 */
export async function scanRolloutLines(
  handle: FileHandle,
  cursor: RolloutScanCursor,
  end: number,
  limits: RolloutScanLimits,
  onLines: (lines: RolloutLine[]) => void,
): Promise<RolloutScanResult> {
  let position = cursor.offset;
  let overlongFrom = cursor.overlongFrom;
  let lineStart = overlongFrom ?? cursor.offset;
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let bytesRead = 0;
  let shortRead = false;
  let buffer: Buffer | undefined;
  let chunks = 0;

  while (position < end) {
    if (chunks > 0) await yieldToEventLoop();
    chunks += 1;
    const length = Math.min(limits.chunkBytes, end - position);
    buffer ??= Buffer.allocUnsafe(Math.min(limits.chunkBytes, Math.max(1, end - position)));
    const { bytesRead: read } = await handle.read(buffer, 0, length, position);
    if (read <= 0) {
      shortRead = true;
      break;
    }
    bytesRead += read;
    const lines: RolloutLine[] = [];
    let index = 0;

    if (overlongFrom !== undefined) {
      const newline = buffer.indexOf(NEWLINE, 0);
      if (newline < 0 || newline >= read) {
        position += read;
        continue;
      }
      lines.push({ kind: "overlong", start: overlongFrom, end: position + newline + 1 });
      overlongFrom = undefined;
      index = newline + 1;
      lineStart = position + index;
    }

    while (index < read) {
      const found = buffer.indexOf(NEWLINE, index);
      const newline = found >= 0 && found < read ? found : -1;
      if (newline < 0) {
        const tail = read - index;
        if (carryBytes + tail > limits.maxRecordBytes) {
          // Stop carrying: the line is already too long to parse, so the rest
          // of it is skipped as it streams past rather than accumulated.
          overlongFrom = lineStart;
          carry = [];
          carryBytes = 0;
        } else {
          // Copy: `buffer` is reused for the next chunk.
          carry.push(Buffer.from(buffer.subarray(index, read)));
          carryBytes += tail;
        }
        break;
      }

      const lineEnd = position + newline + 1;
      const lineBytes = carryBytes + (newline - index);
      if (lineBytes > limits.maxRecordBytes) {
        lines.push({ kind: "overlong", start: lineStart, end: lineEnd });
      } else {
        const text =
          carry.length === 0
            ? buffer.toString("utf8", index, newline)
            : Buffer.concat([...carry, buffer.subarray(index, newline)]).toString("utf8");
        lines.push({ kind: "line", text, start: lineStart, end: lineEnd });
      }
      carry = [];
      carryBytes = 0;
      index = newline + 1;
      lineStart = lineEnd;
    }

    position += read;
    if (lines.length > 0) onLines(lines);
  }

  return {
    // An incomplete line is not retained: the next scan re-reads it from its
    // start, so a cached transcript never holds more than its parsed records.
    cursor: overlongFrom !== undefined ? { offset: position, overlongFrom } : { offset: lineStart },
    bytesRead,
    shortRead,
  };
}
