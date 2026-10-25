/**
 * Code-mode calls app-server reports no item for, read from the rollout.
 *
 * Every model Codex 0.162.1 serves runs in code mode: the model sends one
 * `exec` cell of JavaScript that calls `tools.apply_patch(...)` or
 * `tools.exec_command(...)`. app-server streams an item for each nested call,
 * with one gap. Under a sandbox, it emits nothing for a call the sandbox
 * refuses: a rejected patch, or a failing command whose output looks like a
 * sandbox denial ("Operation not permitted", "Permission denied", "Read-only
 * file system"…). The model is told about the refusal and usually says so,
 * while the transcript shows no row for the attempt
 * (`app-server/live-refused-calls.test.ts`).
 *
 * The cell itself is never streamed either; only the rollout keeps it, with
 * the output the model got back. This tail reads what one turn appends to the
 * rollout and reports a cell when nothing else would show it:
 *
 * - no client tool item of the turn started while the cell ran, so every call
 *   it made was refused (or it made none); or
 * - its output carries a refusal ({@link STRONG_REFUSAL_MARKERS}), so a call
 *   inside a cell that also produced items was refused.
 *
 * A cell an interrupt stopped is never reported, even with no item: it is not
 * a refusal, and its output says only that the user stopped it.
 *
 * A cell that produced items and reports no refusal is left alone: its calls
 * are already on screen. Codex writes the cell's output about 50 ms before it
 * asks the model for the next response, so a read every
 * {@link ROLLOUT_POLL_INTERVAL_MS} while the turn runs nearly always places
 * the row before that response's first item. `fs.watch` cannot do it: on
 * macOS it reports nothing for Codex's appends through its open descriptor.
 */
import { open, stat } from "node:fs/promises";
import {
  MAX_ROLLOUT_RECORD_BYTES,
  ROLLOUT_CHUNK_BYTES,
  scanRolloutLines,
  type RolloutScanCursor,
} from "../rollout-reader.js";

/**
 * Refusal text that does not occur in ordinary command output often enough
 * to matter. Codex's own denial heuristic also matches "sandbox", "landlock",
 * "seccomp" and "failed to write file"; those are left to the no-item rule,
 * because a cell that merely printed a file mentioning them would otherwise
 * gain a second row.
 */
export const STRONG_REFUSAL_MARKERS = [
  "patch rejected",
  "operation not permitted",
  "permission denied",
  "read-only file system",
] as const;

/** Codex's prefix for a cell that threw, including a rejected `apply_patch`. */
const SCRIPT_FAILED = "script failed";

/**
 * Codex's whole output for a cell an interrupt stopped. With
 * `features.code_mode_interrupt` (on by default since 0.164.0) a user stop
 * terminates the running cell and records `aborted by user after 1.5s` as its
 * output (`app-server/live-refused-calls.test.ts`).
 */
const INTERRUPTED_CELL = /^aborted by user\b/i;

/** Pending cells kept while waiting for their output; more are ignored. */
const MAX_PENDING_CELLS = 256;
/** A cell's source and output are kept up to this many characters each. */
export const MAX_CELL_TEXT_CHARS = 64 * 1024;

export interface RefusedCell {
  /** The rollout's `call_id`, which a reload uses as the row's id too. */
  callId: string;
  /** The cell's JavaScript source. */
  source: string;
  /** The text the model got back. */
  output: string;
  /** True when the output reports a refusal or a failed script. */
  failed: boolean;
  startedAtMs?: number;
  completedAtMs?: number;
}

export interface RolloutWatcher {
  close(): void;
}

/** How often the default watcher asks for a read while a turn runs. */
export const ROLLOUT_POLL_INTERVAL_MS = 200;

/**
 * Calls `onChange` whenever the rollout may have grown: a timer by default,
 * injected in tests so nothing waits on a real clock. A read that finds no new
 * bytes costs one `stat`.
 */
export type WatchRolloutFile = (path: string, onChange: () => void) => RolloutWatcher;

export interface RefusedCellTailOptions {
  path: string;
  turnId: string;
  /** Byte boundary captured before dispatch; absent on recovery uses a bounded turn-ID scan. */
  offset?: number;
  onCell: (cell: RefusedCell) => void;
  /** Whether a client tool item of the turn started in `[fromMs, toMs]`. */
  itemStartedBetween: (fromMs: number, toMs: number) => boolean;
  watch?: WatchRolloutFile;
}

/** The text of a cell's output as the model got it back. */
export function cellOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? null) ?? "";
  return output
    .map((part) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function recordTimeMs(record: Record<string, unknown>, payload: Record<string, unknown>): number {
  const written = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const passthrough = payload.internal_chat_message_metadata_passthrough as
    | { create_time?: unknown }
    | undefined;
  const created =
    typeof passthrough?.create_time === "number" ? passthrough.create_time * 1000 : NaN;
  // A record is written a little after it is created, so the earlier of the
  // two is when the call began.
  const times = [written, created].filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : NaN;
}

function turnIdOf(payload: Record<string, unknown>): string | undefined {
  const passthrough = payload.internal_chat_message_metadata_passthrough as
    | { turn_id?: unknown }
    | undefined;
  return typeof passthrough?.turn_id === "string" ? passthrough.turn_id : undefined;
}

/** Whether the model was told a call was refused. */
export function reportsRefusal(output: string): boolean {
  const lower = output.toLowerCase();
  return STRONG_REFUSAL_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Whether a cell's output reports a refused call, a script that threw, or a
 * cell an interrupt stopped. An interrupted cell is neither refused nor failed:
 * the user stopped it, and whatever it called already shows as its own item.
 */
export function codeModeCellOutcome(output: string): {
  refused: boolean;
  failed: boolean;
  interrupted: boolean;
} {
  const refused = reportsRefusal(output);
  const trimmed = output.trimStart();
  return {
    refused,
    failed: refused || trimmed.toLowerCase().startsWith(SCRIPT_FAILED),
    interrupted: !refused && INTERRUPTED_CELL.test(trimmed),
  };
}

function defaultWatch(_path: string, onChange: () => void): RolloutWatcher {
  const timer = setInterval(onChange, ROLLOUT_POLL_INTERVAL_MS);
  timer.unref?.();
  return { close: () => clearInterval(timer) };
}

/**
 * Follows one turn's records in one rollout. Reads are serialized: a change
 * that arrives mid-read schedules exactly one more.
 */
export class RefusedCellTail {
  private readonly options: RefusedCellTailOptions;
  /** Starts at the pre-dispatch boundary, or a bounded recovery range. */
  private cursor: RolloutScanCursor | undefined;
  private readonly pending = new Map<string, { source: string; startedAtMs: number }>();
  private readonly reported = new Set<string>();
  private watcher: RolloutWatcher | undefined;
  private reading: Promise<void> | undefined;
  private again = false;
  private closed = false;

  /**
   * The dispatch boundary includes cells written before turn.started is applied.
   * Recovery without that boundary admits only explicitly matching turn IDs.
   */
  constructor(options: RefusedCellTailOptions) {
    this.options = options;
  }

  /** The read in flight, if any; settled reads leave nothing to wait for. */
  busy(): Promise<void> | undefined {
    return this.reading;
  }

  /** Reads what was appended since the last read; the first read also starts the watch. */
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      try {
        do {
          this.again = false;
          await this.readAppended();
        } while (this.again && !this.closed);
      } finally {
        this.reading = undefined;
      }
    })();
    return this.reading;
  }

  /** One last read, then stop watching. */
  async finish(): Promise<void> {
    await this.poll().catch(() => undefined);
    this.close();
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.pending.clear();
  }

  private attachWatch(): void {
    if (this.watcher || this.closed) return;
    try {
      this.watcher = (this.options.watch ?? defaultWatch)(this.options.path, () => {
        void this.poll().catch(() => undefined);
      });
    } catch {
      // A watcher that cannot start leaves the item-event polls and the read
      // at turn end, which still find the cell, only later.
    }
  }

  private async readAppended(): Promise<void> {
    const size = await stat(this.options.path).then(
      (stats) => stats.size,
      () => undefined,
    );
    if (!this.cursor) {
      const offset = this.options.offset ?? Math.max(0, (size ?? 0) - MAX_ROLLOUT_RECORD_BYTES);
      this.cursor =
        offset > 0 && this.options.offset === undefined
          ? { offset, overlongFrom: offset }
          : { offset };
      this.attachWatch();
    }
    if (this.closed || size === undefined) return;
    if (size < this.cursor.offset) {
      // Rewritten underneath us; nothing before the turn can be trusted.
      this.cursor = { offset: size };
      return;
    }
    if (size === this.cursor.offset) return;
    const handle = await open(this.options.path, "r");
    try {
      const result = await scanRolloutLines(
        handle,
        this.cursor,
        size,
        { maxRecordBytes: MAX_ROLLOUT_RECORD_BYTES, chunkBytes: ROLLOUT_CHUNK_BYTES },
        (lines) => {
          for (const line of lines) if (line.kind === "line") this.readLine(line.text);
        },
      );
      this.cursor = result.cursor;
    } finally {
      await handle.close();
    }
  }

  private readLine(text: string): void {
    if (this.closed || !text.includes('"custom_tool_call')) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type !== "response_item" || !payload || typeof payload.call_id !== "string") {
      return;
    }
    const turnId = turnIdOf(payload);
    if (
      turnId !== this.options.turnId &&
      (turnId !== undefined || this.options.offset === undefined)
    )
      return;
    const callId = payload.call_id;
    if (payload.type === "custom_tool_call") {
      if (
        payload.name !== "exec" ||
        this.pending.size >= MAX_PENDING_CELLS ||
        this.reported.has(callId)
      )
        return;
      const source = typeof payload.input === "string" ? payload.input : "";
      this.pending.set(callId, {
        source: source.slice(0, MAX_CELL_TEXT_CHARS),
        startedAtMs: recordTimeMs(record, payload),
      });
      return;
    }
    if (payload.type !== "custom_tool_call_output") return;
    const cell = this.pending.get(callId);
    if (!cell || this.reported.has(callId)) return;
    this.pending.delete(callId);
    const output = cellOutputText(payload.output);
    const completedAtMs = recordTimeMs(record, payload);
    const { refused, failed, interrupted } = codeModeCellOutcome(output);
    // An interrupted cell is not a refusal, and the turn is ending at the
    // user's request: no row, whatever it managed to start.
    if (interrupted) return;
    const unseen =
      !Number.isFinite(cell.startedAtMs) ||
      !Number.isFinite(completedAtMs) ||
      !this.options.itemStartedBetween(cell.startedAtMs, completedAtMs);
    if (!refused && !unseen) return;
    this.reported.add(callId);
    this.options.onCell({
      callId,
      source: cell.source.slice(0, MAX_CELL_TEXT_CHARS),
      output: output.slice(0, MAX_CELL_TEXT_CHARS),
      failed,
      ...(Number.isFinite(cell.startedAtMs) ? { startedAtMs: cell.startedAtMs } : {}),
      ...(Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
    });
  }
}
