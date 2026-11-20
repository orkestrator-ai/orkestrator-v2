/**
 * Hidden terminal tabs' output, fed into xterm.js when the page is idle (to-do
 * 8312 task 2; measurements in docs/development/terminal-latency.md).
 *
 * A hidden tab stays subscribed and keeps its exact history (decided
 * 2026-10-27 in docs/development/remote-bandwidth.md), so every byte it
 * receives is still parsed. What changes is when: xterm.js parses each write in
 * up to 12 ms tasks, and with several busy hidden tabs those tasks queued
 * ahead of the visible tab's echo. Here a hidden tab's writes wait in a FIFO
 * and are handed to xterm one slice at a time, from `requestIdleCallback`,
 * with a single slice in flight across every hidden terminal of the page. Input
 * and rendering run before idle callbacks, so the typing tab's frames go first,
 * and a key waits behind at most one slice's parse.
 *
 * Nothing is dropped or reordered:
 *
 * - Each terminal's bytes reach xterm in arrival order; a slice may split a
 *   write (xterm keeps its UTF-8 and parser state across writes).
 * - A write's completion callback fires once xterm has parsed its last byte.
 * - Revealing the tab, a replay, a pane move and unmount all `flush()` the
 *   queue into xterm at once, ahead of anything that follows.
 * - A queue past its byte or count bound is flushed the same way rather than
 *   growing, so a hidden tab that out-produces idle time falls back to xterm's
 *   own write buffer, which is what every write used before.
 */

/** Hands bytes to xterm; `parsed` runs once xterm has parsed them. */
export type TerminalWriteSink = (data: Uint8Array, parsed: () => void) => void;

export interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}

export interface IdleScheduling {
  request(callback: (deadline: IdleDeadlineLike) => void, timeoutMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Largest slice handed to xterm from one idle callback. */
export const BACKGROUND_SLICE_BYTES = 32 * 1024;
/** An idle callback runs anyway after this long, so a busy page still makes progress. */
export const BACKGROUND_IDLE_TIMEOUT_MS = 200;
/** A slice whose parse never reports back releases the page's slot after this long. */
export const SLICE_WATCHDOG_MS = 2_000;
/** Bytes a hidden terminal may hold back before it flushes straight into xterm. */
export const BACKGROUND_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** Writes a hidden terminal may hold back before it flushes straight into xterm. */
export const BACKGROUND_MAX_QUEUED_WRITES = 4_096;

export interface BackgroundWriteMetrics {
  /** Slices handed to xterm from idle callbacks. */
  slices: number;
  /** Bytes handed over in those slices. */
  sliceBytes: number;
  /** Queues flushed at once (reveal, replay, unmount, bound). */
  flushes: number;
  /** Of those, flushes forced by a queue bound. */
  boundFlushes: number;
}

interface Gate {
  /** Hands xterm at most `maxBytes`; answers the bytes handed over (0 when empty). */
  issueSlice(maxBytes: number, done: () => void): number;
  hasQueued(): boolean;
}

export interface BackgroundWriteScheduler {
  /** Marks a gate as having queued bytes. */
  ready(gate: Gate): void;
  remove(gate: Gate): void;
  readonly metrics: BackgroundWriteMetrics;
  dispose(): void;
}

function defaultIdleScheduling(): IdleScheduling {
  const scope = globalThis as typeof globalThis & {
    requestIdleCallback?: (
      callback: (deadline: IdleDeadlineLike) => void,
      options?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scope.requestIdleCallback === "function") {
    return {
      request: (callback, timeoutMs) =>
        scope.requestIdleCallback!(callback, { timeout: timeoutMs }),
      cancel: (handle) => scope.cancelIdleCallback?.(handle as number),
    };
  }
  // WebKit has no idle callbacks: one slice per frame-sized pause instead.
  return {
    request: (callback) =>
      setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 16),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createBackgroundWriteScheduler(
  options: {
    idle?: IdleScheduling;
    sliceBytes?: number;
    idleTimeoutMs?: number;
    watchdogMs?: number;
    /** The watchdog's timer; tests drive it by hand. */
    timers?: {
      set(callback: () => void, ms: number): unknown;
      clear(handle: unknown): void;
    };
  } = {},
): BackgroundWriteScheduler {
  const idle = options.idle ?? defaultIdleScheduling();
  const sliceBytes = options.sliceBytes ?? BACKGROUND_SLICE_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? BACKGROUND_IDLE_TIMEOUT_MS;
  const watchdogMs = options.watchdogMs ?? SLICE_WATCHDOG_MS;
  const timers = options.timers ?? {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  // Insertion-ordered: the gate that waited longest goes next.
  const waiting = new Set<Gate>();
  const metrics: BackgroundWriteMetrics = { slices: 0, sliceBytes: 0, flushes: 0, boundFlushes: 0 };
  let handle: unknown = null;
  /** The gate whose slice xterm is parsing; at most one across the page. */
  let inFlight: Gate | null = null;
  let watchdog: unknown = null;
  let disposed = false;

  const schedule = () => {
    if (disposed || inFlight || handle !== null || waiting.size === 0) return;
    handle = idle.request(run, idleTimeoutMs);
  };

  const release = (gate: Gate) => {
    if (inFlight !== gate) return;
    inFlight = null;
    if (watchdog !== null) timers.clear(watchdog);
    watchdog = null;
    schedule();
  };

  const run = () => {
    handle = null;
    for (const gate of Array.from(waiting)) {
      waiting.delete(gate);
      inFlight = gate;
      let settled = false;
      const issued = gate.issueSlice(sliceBytes, () => {
        settled = true;
        release(gate);
      });
      // Round robin: a gate with more queued goes behind the others.
      if (gate.hasQueued()) waiting.add(gate);
      if (issued > 0) {
        metrics.slices += 1;
        metrics.sliceBytes += issued;
        // One slice in flight across every hidden terminal: the next idle
        // callback is requested once xterm has parsed this one. A terminal
        // disposed mid-parse never calls back, so the slot is not held forever.
        if (settled) schedule();
        else watchdog = timers.set(() => release(gate), watchdogMs);
        return;
      }
      inFlight = null;
    }
  };

  return {
    ready(gate) {
      if (disposed) return;
      waiting.add(gate);
      schedule();
    },
    remove(gate) {
      waiting.delete(gate);
      release(gate);
    },
    metrics,
    dispose() {
      disposed = true;
      waiting.clear();
      if (handle !== null) idle.cancel(handle);
      handle = null;
      if (watchdog !== null) timers.clear(watchdog);
      watchdog = null;
      inFlight = null;
    },
  };
}

type Queued = { data: Uint8Array; offset: number; parsed?: () => void };

export interface TerminalWriteGate {
  /** Writes now when the tab is shown and nothing is queued; otherwise queues. */
  write(data: Uint8Array, parsed?: () => void): void;
  /** A shown tab flushes its queue at once; a hidden one queues from now on. */
  setHidden(hidden: boolean): void;
  /** Hands every queued byte to xterm now, in order. */
  flush(): void;
  /** Bytes currently held back. */
  queuedBytes(): number;
  /** Flushes and stops scheduling; later writes go straight to xterm. */
  dispose(): void;
}

export function createTerminalWriteGate(
  sink: TerminalWriteSink,
  scheduler: BackgroundWriteScheduler,
  options: { hidden?: boolean; maxQueuedBytes?: number; maxQueuedWrites?: number } = {},
): TerminalWriteGate {
  const maxQueuedBytes = options.maxQueuedBytes ?? BACKGROUND_MAX_QUEUED_BYTES;
  const maxQueuedWrites = options.maxQueuedWrites ?? BACKGROUND_MAX_QUEUED_WRITES;
  const queue: Queued[] = [];
  let bytes = 0;
  let hidden = options.hidden ?? false;
  let disposed = false;

  const handOver = (entry: Queued, end: number, last: boolean, done?: () => void) => {
    const piece =
      entry.offset === 0 && end === entry.data.byteLength
        ? entry.data
        : entry.data.subarray(entry.offset, end);
    bytes -= end - entry.offset;
    entry.offset = end;
    const parsed = last ? entry.parsed : undefined;
    sink(piece, () => {
      parsed?.();
      done?.();
    });
  };

  const gate: Gate = {
    issueSlice(maxBytes, done) {
      let budget = maxBytes;
      let issued = 0;
      while (queue.length > 0 && budget > 0) {
        const entry = queue[0]!;
        const end = Math.min(entry.data.byteLength, entry.offset + budget);
        const finished = end === entry.data.byteLength;
        if (finished) queue.shift();
        const size = end - entry.offset;
        budget -= size;
        issued += size;
        // The slice's completion rides on its last piece; xterm parses in order.
        const lastPiece = budget <= 0 || queue.length === 0;
        handOver(entry, end, finished, lastPiece ? done : undefined);
      }
      return issued;
    },
    hasQueued: () => queue.length > 0,
  };

  const flush = (bound = false) => {
    if (queue.length === 0) return;
    scheduler.metrics.flushes += 1;
    if (bound) scheduler.metrics.boundFlushes += 1;
    scheduler.remove(gate);
    for (const entry of queue.splice(0)) handOver(entry, entry.data.byteLength, true);
    bytes = 0;
  };

  return {
    write(data, parsed) {
      if (disposed || (!hidden && queue.length === 0)) {
        sink(data, () => parsed?.());
        return;
      }
      queue.push({ data, offset: 0, parsed });
      bytes += data.byteLength;
      if (!hidden) {
        flush();
        return;
      }
      if (bytes > maxQueuedBytes || queue.length > maxQueuedWrites) {
        flush(true);
        return;
      }
      scheduler.ready(gate);
    },
    setHidden(next) {
      hidden = next;
      if (!hidden) flush();
      else if (queue.length > 0) scheduler.ready(gate);
    },
    flush: () => flush(),
    queuedBytes: () => bytes,
    dispose() {
      flush();
      disposed = true;
      scheduler.remove(gate);
    },
  };
}

let pageScheduler: BackgroundWriteScheduler | null = null;

/** The page's one scheduler, shared by every hidden terminal. */
export function backgroundWriteScheduler(): BackgroundWriteScheduler {
  pageScheduler ??= createBackgroundWriteScheduler();
  return pageScheduler;
}

/** Stops the page's scheduler (its idle callback and watchdog); the next use makes a new one. */
export function disposeBackgroundWriteScheduler(): void {
  pageScheduler?.dispose();
  pageScheduler = null;
}

/**
 * The measurement switch (`docs/development/terminal-latency.md`): setting
 * this local-storage key to `off` before a terminal mounts writes its output
 * straight into xterm whether or not the tab is shown, as before 8312, so the
 * browser benchmark can compare both in one run.
 */
export const BACKGROUND_WRITES_STORAGE_KEY = "orkestrator-terminal-background-writes";

export function backgroundWritesEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(BACKGROUND_WRITES_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
