/**
 * Bounded reads of one tool call's output (docs/architecture/push-events.md,
 * "The `tool-output` topic"): `get_native_agent_tool_output`.
 *
 * A running command's output can grow to megabytes. An expanded row reads the
 * tail of it, appends from its cursor on each `tool-output` change, and reads
 * earlier ranges only when asked. Every read is bounded on both sides: the
 * request's `limit` is clamped to {@link TOOL_OUTPUT_READ_MAX_BYTES}, and the
 * answer carries at most that many bytes of text.
 *
 * Offsets are UTF-8 byte offsets into the call's whole output. A range never
 * splits a character: its start moves forward and its end backward to the
 * nearest character boundary, and the answer reports the offsets it used.
 *
 * Anchors make appends safe without assuming output only grows: the answer
 * carries an opaque anchor for each end of the range, and a later read from
 * that end sends it back. When the bytes beside the cursor are no longer the
 * ones the anchor was minted over (the output was rewritten, or the row now
 * names another body) the read answers the tail with `reset: true` and the
 * client replaces what it holds.
 *
 * Browser-safe: no Node or Bun imports.
 */

export const GET_NATIVE_AGENT_TOOL_OUTPUT_COMMAND = "get_native_agent_tool_output";

/** The most text one read returns. */
export const TOOL_OUTPUT_READ_MAX_BYTES = 64 * 1024;
/** What a read returns when it names no limit. */
export const TOOL_OUTPUT_READ_DEFAULT_BYTES = 32 * 1024;
/** A tool call id longer than this is refused. */
export const TOOL_OUTPUT_TOOL_ID_MAX_BYTES = 256;
/** A tool error longer than this is cut, keeping its start. */
export const TOOL_OUTPUT_ERROR_MAX_BYTES = 8 * 1024;
/** Bytes on each side of a cursor an anchor covers. */
export const TOOL_OUTPUT_ANCHOR_BYTES = 64;
const ANCHOR_MAX_LENGTH = 32;
/** Cursors past this are refused (the projection holds at most a few MiB per body). */
const CURSOR_MAX = 2 ** 31;

/**
 * - `tail`: the newest `limit` bytes.
 * - `range`: `limit` bytes forward from `cursor` (appending after a held end).
 * - `before`: `limit` bytes ending at `cursor` (history before a held start).
 */
export type ToolOutputReadMode = "tail" | "range" | "before";

export interface ToolOutputReadRequest {
  mode: ToolOutputReadMode;
  /** Byte offset; required for `range` and `before`. */
  cursor?: number;
  /** The anchor the previous answer gave for `cursor`. */
  anchor?: string;
  /** Clamped to 1..{@link TOOL_OUTPUT_READ_MAX_BYTES}. */
  limit: number;
}

export interface NativeAgentToolOutputReadInput extends ToolOutputReadRequest {
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
  toolUseId: string;
  /**
   * The detail reference the row holds. Used only when the call is no longer
   * in the session's live view (an older row loaded through history).
   */
  detailRef?: string;
}

export interface ToolOutputSlice {
  text: string;
  /** Byte offsets of `text` in the whole output. */
  start: number;
  end: number;
  totalBytes: number;
  /** The range does not start at the beginning of the output. */
  truncatedBefore: boolean;
  /** Echo with a `before` read from `start`. */
  startAnchor: string;
  /** Echo with a `range` read from `end`. */
  endAnchor: string;
  /** The cursor or anchor no longer matched: this is the tail, replace what is held. */
  reset?: true;
}

export type NativeAgentToolOutputRead =
  | ({
      status: "ok";
      /** The tool call has finished: its output will not grow. */
      complete: boolean;
      /** The call's error text, at most {@link TOOL_OUTPUT_ERROR_MAX_BYTES}. */
      toolError?: string;
    } & ToolOutputSlice)
  /** No such session or tool call in it. */
  | { status: "missing" }
  /** The call's output was known but is no longer held; the row reads it through its details. */
  | { status: "expired" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function forwardToBoundary(bytes: Uint8Array, offset: number): number {
  let index = offset;
  while (index < bytes.length && isContinuationByte(bytes[index])) index += 1;
  return index;
}

function backwardToBoundary(bytes: Uint8Array, offset: number): number {
  let index = offset;
  while (index > 0 && index < bytes.length && isContinuationByte(bytes[index])) index -= 1;
  return index;
}

/** FNV-1a 32, hex: anchors only need to notice a rewrite, not resist one. */
function fnv1a(bytes: Uint8Array, from: number, to: number): string {
  let hash = 0x811c9dc5;
  for (let index = from; index < to; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The anchor for the bytes just before `offset` (an end a client appends after). */
function endAnchorAt(bytes: Uint8Array, offset: number): string {
  const from = Math.max(0, offset - TOOL_OUTPUT_ANCHOR_BYTES);
  return `e${offset - from}.${fnv1a(bytes, from, offset)}`;
}

/** The anchor for the bytes from `offset` up to `limit` (a start a client reads before). */
function startAnchorAt(bytes: Uint8Array, offset: number, limit: number): string {
  const to = Math.min(limit, offset + TOOL_OUTPUT_ANCHOR_BYTES);
  return `s${to - offset}.${fnv1a(bytes, offset, to)}`;
}

function anchorMatches(bytes: Uint8Array, cursor: number, anchor: string): boolean {
  const match = /^([es])(\d{1,3})\.[0-9a-f]{8}$/u.exec(anchor);
  if (!match) return false;
  const length = Number(match[2]);
  if (match[1] === "e") {
    if (length > cursor) return false;
    return anchor === `e${length}.${fnv1a(bytes, cursor - length, cursor)}`;
  }
  if (cursor + length > bytes.length) return false;
  return anchor === `s${length}.${fnv1a(bytes, cursor, cursor + length)}`;
}

/** Clamp a requested limit into the read's bound. */
export function clampToolOutputLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return TOOL_OUTPUT_READ_DEFAULT_BYTES;
  return Math.max(1, Math.min(TOOL_OUTPUT_READ_MAX_BYTES, Math.floor(limit)));
}

/**
 * One bounded slice of `output`. A `range` or `before` read whose cursor is
 * past the end, splits a character, or whose anchor no longer matches answers
 * the tail with `reset`.
 */
export function sliceToolOutput(output: string, request: ToolOutputReadRequest): ToolOutputSlice {
  const bytes = encoder.encode(output);
  const total = bytes.length;
  const limit = clampToolOutputLimit(request.limit);
  const make = (start: number, end: number, reset: boolean): ToolOutputSlice => ({
    text: decoder.decode(bytes.subarray(start, end)),
    start,
    end,
    totalBytes: total,
    truncatedBefore: start > 0,
    startAnchor: startAnchorAt(bytes, start, end),
    endAnchor: endAnchorAt(bytes, end),
    ...(reset ? { reset: true as const } : {}),
  });
  const tail = (reset: boolean) => {
    const start = forwardToBoundary(bytes, Math.max(0, total - limit));
    return make(start, total, reset);
  };
  if (request.mode === "tail") return tail(false);
  const cursor = request.cursor;
  if (
    cursor === undefined ||
    cursor > total ||
    isContinuationByte(bytes[cursor]) ||
    (request.anchor !== undefined && !anchorMatches(bytes, cursor, request.anchor))
  ) {
    return tail(true);
  }
  if (request.mode === "range") {
    const end = backwardToBoundary(bytes, Math.min(total, cursor + limit));
    return make(cursor, Math.max(cursor, end), false);
  }
  const start = forwardToBoundary(bytes, Math.max(0, cursor - limit));
  return make(Math.min(start, cursor), cursor, false);
}

/** Cut an error text to its bound, keeping the start. */
export function boundToolOutputError(error: string): string {
  const bytes = encoder.encode(error);
  if (bytes.length <= TOOL_OUTPUT_ERROR_MAX_BYTES) return error;
  const end = backwardToBoundary(bytes, TOOL_OUTPUT_ERROR_MAX_BYTES);
  return `${decoder.decode(bytes.subarray(0, end))}…`;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Validates and normalizes a read's arguments. Throws with a message that
 * names the argument, never its value.
 */
export function parseToolOutputReadInput(args: {
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
  toolUseId: string;
  detailRef?: string;
  mode?: string;
  cursor?: number;
  anchor?: string;
  limit?: number;
}): NativeAgentToolOutputReadInput {
  const { toolUseId, detailRef, anchor, cursor } = args;
  if (toolUseId.trim().length === 0 || utf8Bytes(toolUseId) > TOOL_OUTPUT_TOOL_ID_MAX_BYTES) {
    throw new Error("toolUseId must be a bounded, non-blank string");
  }
  if (detailRef !== undefined && (detailRef.length === 0 || detailRef.length > 128)) {
    throw new Error("detailRef must be a bounded string");
  }
  const mode = args.mode ?? "tail";
  if (mode !== "tail" && mode !== "range" && mode !== "before") {
    throw new Error("mode must be tail, range or before");
  }
  if (
    cursor !== undefined &&
    (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > CURSOR_MAX)
  ) {
    throw new Error("cursor must be a non-negative integer");
  }
  if (mode !== "tail" && cursor === undefined) {
    throw new Error("cursor is required for range and before reads");
  }
  if (anchor !== undefined && anchor.length > ANCHOR_MAX_LENGTH) {
    throw new Error("anchor must be a bounded string");
  }
  return {
    environmentId: args.environmentId,
    agent: args.agent,
    logicalSessionKey: args.logicalSessionKey,
    toolUseId,
    ...(detailRef === undefined ? {} : { detailRef }),
    mode,
    ...(mode === "tail" || cursor === undefined ? {} : { cursor }),
    ...(mode === "tail" || anchor === undefined ? {} : { anchor }),
    limit: clampToolOutputLimit(args.limit),
  };
}
