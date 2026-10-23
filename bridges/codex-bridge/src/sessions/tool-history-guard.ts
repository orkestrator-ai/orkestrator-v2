/**
 * Whether a thread's history still declares tools to the model.
 *
 * With `features.incremental_tools` (stable and on by default since codex
 * 0.164.0) each turn appends an `additional_tools` record to the rollout, and a
 * resumed thread replays it: a read-only turn's request still carries the
 * build turn's `exec` declaration, `web__run` included, ahead of its own
 * declaration without it. The bridge turns the feature off for the whole
 * app-server (`codexAppServerConfigOverrides`), which writes no such record,
 * and before a turn that denies hosted search runs on a resumed or forked
 * thread it checks that the history it inherits holds none either. A thread
 * written while the feature was on is refused rather than trusted to ignore a
 * tool it was once offered (`live-network-lock.test.ts`).
 *
 * Codex 0.162.1 never wrote these records; neither does 0.164.0 with the
 * feature off.
 */
import { open } from "node:fs/promises";
import { MAX_ROLLOUT_RECORD_BYTES, ROLLOUT_CHUNK_BYTES } from "../rollout-reader.js";

/**
 * The record Codex writes for tools declared into history. Matched on the raw
 * bytes: inside any JSON string value the quotes would be escaped, so only a
 * record's own `type` field can produce this text.
 */
export const TOOL_HISTORY_MARKER = '"type":"additional_tools"';

/** Fork ancestors followed before the answer is "cannot tell". */
export const MAX_TOOL_HISTORY_LINEAGE_DEPTH = 32;

/** `declares` and `unknown` both refuse; only `clean` lets the turn run. */
export type ToolHistoryVerdict = "clean" | "declares" | "unknown";

/** Whether the first `end` bytes of a rollout (all of it when absent) hold the marker. */
export async function rolloutDeclaresToolHistory(path: string, end?: number): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const limit = end === undefined ? size : Math.min(end, size);
    const marker = Buffer.from(TOOL_HISTORY_MARKER);
    const buffer = Buffer.allocUnsafe(ROLLOUT_CHUNK_BYTES + marker.length);
    // Keep the chunk's tail so a marker split across two reads is still found.
    let carried = 0;
    for (let position = 0; position < limit;) {
      const length = Math.min(ROLLOUT_CHUNK_BYTES, limit - position);
      const { bytesRead } = await handle.read(buffer, carried, length, position);
      if (bytesRead <= 0) break;
      const filled = carried + bytesRead;
      if (buffer.subarray(0, filled).includes(marker)) return true;
      position += bytesRead;
      carried = Math.min(marker.length - 1, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** The ancestor a forked rollout's history continues from, read from its `session_meta`. */
async function historyBase(
  path: string,
): Promise<{ threadId: string; endByte?: number } | null | "unreadable"> {
  const handle = await open(path, "r");
  try {
    // The first record, read a chunk at a time up to the record size limit.
    const chunks: Buffer[] = [];
    let filled = 0;
    let complete = false;
    while (filled < MAX_ROLLOUT_RECORD_BYTES) {
      const chunk = Buffer.allocUnsafe(ROLLOUT_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled);
      if (bytesRead <= 0) {
        complete = true;
        break;
      }
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(chunk.subarray(0, newline >= 0 ? newline : bytesRead));
      filled += bytesRead;
      if (newline >= 0) {
        complete = true;
        break;
      }
    }
    if (!complete) return "unreadable";
    const line = Buffer.concat(chunks).toString("utf8");
    if (!line.trim()) return null;
    let record: { type?: unknown; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return "unreadable";
    }
    if (record.type !== "session_meta" || !record.payload) return null;
    const base = record.payload.history_base as
      | { thread_id?: unknown; end_byte_offset?: unknown }
      | undefined;
    if (base && typeof base === "object") {
      if (typeof base.thread_id !== "string") return "unreadable";
      return {
        threadId: base.thread_id,
        ...(typeof base.end_byte_offset === "number" ? { endByte: base.end_byte_offset } : {}),
      };
    }
    // An older fork copied its parent's history into its own file.
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Whether a thread's rollout, or any fork ancestor its history continues
 * from, declares tools into history. An ancestor that cannot be found or read
 * is `unknown`, which callers treat like `declares`.
 */
export async function threadToolHistoryVerdict(
  rolloutPath: string,
  resolveRollout: (threadId: string) => Promise<string | null | undefined>,
): Promise<ToolHistoryVerdict> {
  let path: string | null | undefined = rolloutPath;
  let end: number | undefined;
  for (let depth = 0; depth <= MAX_TOOL_HISTORY_LINEAGE_DEPTH; depth += 1) {
    if (!path) return "unknown";
    try {
      if (await rolloutDeclaresToolHistory(path, end)) return "declares";
      const base = await historyBase(path);
      if (base === "unreadable") return "unknown";
      if (!base) return "clean";
      end = base.endByte;
      path = await resolveRollout(base.threadId);
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}
