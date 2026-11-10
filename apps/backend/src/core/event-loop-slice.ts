/**
 * Cooperative time slicing for long synchronous loops on the backend's event
 * loop. Everything the backend serves shares that loop
 * (`event-loop-stall-monitor.ts`), so a loop over thousands of files or rows
 * that never awaits holds every command, poll and stream for its whole run.
 *
 * A slicer is called between units of work. Once `sliceMs` of work has run
 * since the last yield it waits for one macrotask (`setImmediate`), so timers,
 * sockets and other jobs run before the loop continues; otherwise it returns at
 * once. A slice should stay well under the stall threshold (1 s) and close to a
 * frame, so the default is 20 ms. One unit longer than a slice still runs whole:
 * slicing bounds the stall at a slice plus the longest single unit.
 */

export const EVENT_LOOP_SLICE_MS = 20;

export interface EventLoopSlicerOptions {
  sliceMs?: number;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Lets other work run; a macrotask by default. */
  yieldNow?: () => Promise<void>;
}

/** Returns a function to await between units of work; it yields once per slice. */
export function createEventLoopSlicer(options: EventLoopSlicerOptions = {}): () => Promise<void> {
  const sliceMs = options.sliceMs ?? EVENT_LOOP_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const yieldNow =
    options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let sliceStartedAt = now();
  return async () => {
    if (now() - sliceStartedAt < sliceMs) return;
    await yieldNow();
    sliceStartedAt = now();
  };
}
