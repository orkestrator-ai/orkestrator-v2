import { TaskSnapshotHistory, TranscriptTaskTracker } from "./claude-transcript-tasks.js";
import type { TmuxBackend } from "./tmux-backend.js";
import { TranscriptTail, permissionModeFromTranscriptLine } from "./tmux-hooks.js";
import { AsyncMutex, type TaskListSnapshot } from "./tmux-shared.js";
import { transcriptToolDiffs } from "./tmux-transcript-tool-diffs.js";

/**
 * Bytes of transcript one page covers. A reopen reads this much from the tail
 * rather than the whole file: on one host's 3,976 Claude transcripts it holds
 * the median file whole (171 KB), while the largest reach 37 MB.
 */
export const TMUX_TRANSCRIPT_PAGE_BYTES = 512 * 1024;
/** Records one page returns, whatever their size. */
export const TMUX_TRANSCRIPT_PAGE_LINES = 500;
/**
 * The read window grows up to this to reach a whole record longer than a page.
 * A longer record is left out with a notice row, so the read stays bounded.
 */
export const TMUX_TRANSCRIPT_MAX_LINE_BYTES = 32 * 1024 * 1024;

export type TmuxTranscriptPage = {
  /** The page's records, oldest first, carrying what the whole-file read stamped. */
  lines: unknown[];
  /** Asks for the page before this one; null when this page reaches the file's start. */
  earlierCursor: string | null;
  /** The cursor belongs to another session or to a file since replaced by a shorter one. */
  expired?: true;
  /** The session's mode, which an older line outside the page may have set. */
  permissionMode?: string;
};

export type TranscriptPageLimits = {
  pageBytes: number;
  pageLines: number;
  maxLineBytes: number;
};

const DEFAULT_PAGE_LIMITS: TranscriptPageLimits = {
  pageBytes: TMUX_TRANSCRIPT_PAGE_BYTES,
  pageLines: TMUX_TRANSCRIPT_PAGE_LINES,
  maxLineBytes: TMUX_TRANSCRIPT_MAX_LINE_BYTES,
};

const LINE_FEED = 0x0a;

function parseRecord(bytes: Buffer): unknown {
  const text = bytes.toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A malformed record, or the fragment of one still being written.
    return undefined;
  }
}

/**
 * The newest whole records of a window of the file, within the page bounds.
 *
 * Only bytes after the window's first line feed are known to start a record,
 * so a window that opens exactly on a record boundary still hands its first
 * record to the next page rather than losing it.
 */
export function cutTranscriptWindow(
  window: { start: number; bytes: Buffer },
  options: Pick<TranscriptPageLimits, "pageBytes" | "pageLines"> & { unterminated: boolean },
): { records: unknown[]; firstOffset: number; endOffset: number; reachedRecord: boolean } {
  const { start, bytes } = window;
  const terminatedEnd = bytes.lastIndexOf(LINE_FEED) + 1;
  const firstStart = start === 0 ? 0 : bytes.indexOf(LINE_FEED) + 1;
  const records: unknown[] = [];
  let used = 0;
  let endOffset = start + terminatedEnd;

  // Only the end of the file can hold a record its writer has not terminated.
  if (options.unterminated && terminatedEnd < bytes.length) {
    const record = parseRecord(bytes.subarray(terminatedEnd));
    if (record !== undefined) {
      records.push(record);
      used = bytes.length - terminatedEnd;
      endOffset = start + bytes.length;
    }
  }

  let lineEnd = terminatedEnd;
  while (lineEnd > firstStart) {
    const previousFeed = lineEnd >= 2 ? bytes.lastIndexOf(LINE_FEED, lineEnd - 2) : -1;
    const lineStart = Math.max(previousFeed + 1, firstStart);
    const length = lineEnd - lineStart;
    if (records.length >= options.pageLines) break;
    if (records.length > 0 && used + length > options.pageBytes) break;
    const record = parseRecord(bytes.subarray(lineStart, lineEnd));
    if (record !== undefined) {
      records.push(record);
      used += length;
    }
    lineEnd = lineStart;
  }

  records.reverse();
  return {
    records,
    firstOffset: start + lineEnd,
    endOffset,
    reachedRecord: records.length > 0 || terminatedEnd > firstStart,
  };
}

function encodeCursor(sessionId: string, offset: number): string {
  return `${sessionId}:${offset}`;
}

/** The byte offset a cursor names, or null when it does not name one in this session. */
function decodeCursor(cursor: string, sessionId: string): number | null {
  const separator = cursor.lastIndexOf(":");
  if (separator < 0 || cursor.slice(0, separator) !== sessionId) return null;
  const digits = cursor.slice(separator + 1);
  if (!/^\d+$/.test(digits)) return null;
  const offset = Number(digits);
  return Number.isSafeInteger(offset) ? offset : null;
}

/** Sees each tail line once, in file order, as read and as stamped for the renderer. */
export type TailLineSink = (line: unknown, stamped: unknown) => void;

/**
 * Reads one session's transcript for three kinds of caller: the poll loop's
 * tail, a tab asking for a page, and a renderer that predates paging.
 *
 * Task state comes from the start of the file, but only the tail reads from
 * there, and only once per session in this backend process. It keeps the
 * tracker current and records each task call's snapshot, so a page read from
 * anywhere in the file can stamp its lines with the list as it stood then
 * without replaying what came before.
 */
export class TmuxTranscriptReader {
  private tracker = new TranscriptTaskTracker();
  private snapshotHistory = new TaskSnapshotHistory();
  private tail: TranscriptTail | undefined;
  /** `TranscriptTail` holds one offset; the poll loop and a page's catch-up share it. */
  private readonly tailLock = new AsyncMutex();
  private catchUps = 0;

  constructor(
    private readonly backend: TmuxBackend,
    private readonly sessionId: string,
    private readonly limits: TranscriptPageLimits = DEFAULT_PAGE_LIMITS,
  ) {}

  get tailFilePath(): string | undefined {
    return this.tail?.filePath;
  }

  /**
   * Taken before reading a file size for {@link drainTail}: a catch-up after
   * that moves the offset past the size, which would look like a truncation.
   */
  get tailEpoch(): number {
    return this.catchUps;
  }

  bindTail(filePath: string): void {
    this.tail ??= new TranscriptTail(filePath);
  }

  /** The task list as of everything the tail has read. */
  taskList(): TaskListSnapshot {
    return this.tracker.snapshot();
  }

  /** Reads whatever was appended, handing each line to `sink`. Answers how many. */
  async drainTail(sink: TailLineSink, knownSize?: number, epoch?: number): Promise<number> {
    return await this.tailLock.runExclusive(async () => {
      if (!this.tail) return 0;
      const size =
        (epoch === this.catchUps ? knownSize : undefined) ??
        (await this.backend.fileSize(this.tail.filePath));
      this.resetIfTruncated(size);
      return this.deliverTailLines(await this.tail!.readNew(this.backend, size), sink);
    });
  }

  /** Reset all state derived from the old file together, under tailLock. */
  private resetIfTruncated(size: number): void {
    if (!this.tail || size >= this.tail.bytesRead) return;
    this.tail = new TranscriptTail(this.tail.filePath);
    this.tracker = new TranscriptTaskTracker();
    this.snapshotHistory = new TaskSnapshotHistory();
    this.catchUps += 1;
  }

  private deliverTailLines(lines: unknown[], sink: TailLineSink): number {
    for (const line of lines) {
      const taskSnapshots = this.tracker.applyLine(line);
      if (taskSnapshots) this.snapshotHistory.record(taskSnapshots);
      sink(line, stampedLine(line, taskSnapshots));
    }
    return lines.length;
  }

  /**
   * One page ending at `before`, or at the end of the file. Costs one read of
   * the window, plus only what the tail has not reached yet: a few bytes on a
   * running tab, or the tail's own one pass when this read gets there first.
   */
  async readPage(
    filePath: string,
    before: string | undefined,
    sink: TailLineSink,
  ): Promise<TmuxTranscriptPage> {
    const end = before === undefined ? undefined : decodeCursor(before, this.sessionId);
    if (end === null) return { lines: [], earlierCursor: null, expired: true };
    this.bindTail(filePath);

    for (let maxBytes = this.limits.pageBytes; ;) {
      const window = await this.backend.readTranscriptWindow(filePath, end, maxBytes);
      if (!window || (end !== undefined && end > window.size)) {
        return end === undefined
          ? { lines: [], earlierCursor: null }
          : { lines: [], earlierCursor: null, expired: true };
      }
      const cut = cutTranscriptWindow(window, { ...this.limits, unterminated: end === undefined });
      if (!cut.reachedRecord && window.start > 0) {
        if (maxBytes < this.limits.maxLineBytes) {
          maxBytes = Math.min(maxBytes * 4, this.limits.maxLineBytes);
          continue;
        }
        return {
          lines: [oversizedRecordNotice(window.start, this.limits.maxLineBytes)],
          earlierCursor: encodeCursor(this.sessionId, window.start),
        };
      }

      await this.tailLock.runExclusive(async () => {
        // A poll may have advanced past the window captured outside this lock.
        // Confirm shrinkage against the current file before resetting shared state.
        const size =
          window.size < this.tail!.bytesRead ? await this.backend.fileSize(filePath) : window.size;
        this.resetIfTruncated(size);
        const tail = this.tail!;
        if (tail.bytesRead >= cut.endOffset) return;
        this.catchUps += 1;
        // The window's size is at least the end of the page, so it cannot read
        // as a truncation; passing it spares the extra stat.
        this.deliverTailLines(await tail.readNew(this.backend, size), sink);
      });

      return {
        lines: cut.records.map((record) =>
          stampedLine(record, this.snapshotHistory.forLine(record)),
        ),
        earlierCursor: cut.firstOffset > 0 ? encodeCursor(this.sessionId, cut.firstOffset) : null,
      };
    }
  }

  /**
   * The whole file, for a renderer that predates paging. Each line carries the
   * list as it stood then, and overlapping with the live tail is safe: every
   * operation the registry models is idempotent.
   */
  async readWhole(filePath: string): Promise<{ lines: unknown[]; permissionMode?: string }> {
    const content = (await this.backend.readFile(filePath)) ?? "";
    const tracker = new TranscriptTaskTracker();
    const lines: unknown[] = [];
    let permissionMode: string | undefined;
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const line = JSON.parse(trimmed);
        const taskSnapshots = tracker.applyLine(line);
        if (taskSnapshots) this.snapshotHistory.record(taskSnapshots);
        lines.push(stampedLine(line, taskSnapshots));
        permissionMode = permissionModeFromTranscriptLine(line) ?? permissionMode;
      } catch {
        // Continue reading later lines.
      }
    }
    this.tracker = tracker;
    return { lines, ...(permissionMode ? { permissionMode } : {}) };
  }
}

/**
 * Attach the resulting task list to a line that completed a task tool call,
 * keyed by `tool_use_id` so it reaches that tool's part and no other, and the
 * diff sides of each tool call it started (`toolDiffs`, keyed by tool use id),
 * leaving every other line untouched.
 */
function stampedLine(line: unknown, taskSnapshots: Record<string, TaskListSnapshot> | undefined) {
  const toolDiffs = transcriptToolDiffs(line);
  if ((!taskSnapshots && !toolDiffs) || typeof line !== "object" || line === null) return line;
  return {
    ...(line as Record<string, unknown>),
    ...(taskSnapshots ? { taskSnapshots } : {}),
    ...(toolDiffs ? { toolDiffs } : {}),
  };
}

function oversizedRecordNotice(offset: number, maxLineBytes: number): unknown {
  const size = Math.round(maxLineBytes / (1024 * 1024));
  return {
    type: "system",
    uuid: `tmux-transcript-omitted-${offset}`,
    content: `A transcript record larger than ${size} MiB is not shown here. The conversation itself is kept.`,
  };
}
