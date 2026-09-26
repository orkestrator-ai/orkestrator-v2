/**
 * Detects that the host slept (or its wall clock jumped forward) by comparing
 * how far the wall clock and the monotonic clock advanced between two ticks.
 * Both advance together while the host runs; only the wall clock advances
 * across a suspension, so their difference is the time the process lost.
 *
 * In-process deadlines are monotonic (`performance.now()`), so they neither
 * fire during a sleep nor count it. On resume the detector reports the lost
 * time once, and each scheduler re-times its due work so overdue keys run
 * once rather than replaying every missed tick (plan step 02, task 8). A
 * backwards wall-clock step is ignored: nothing became overdue.
 */

/** Ticks rarely: detection latency is at most one interval after resume. */
export const HOST_SUSPEND_CHECK_INTERVAL_MS = 10_000;
/** Drift below this is timer latency or clock slew, not a suspension. */
export const HOST_SUSPEND_THRESHOLD_MS = 5_000;

export interface HostSuspendDetectorOptions {
  onSuspend: (suspendedMs: number) => void;
  intervalMs?: number;
  thresholdMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  timers?: {
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

const systemIntervals = {
  setInterval(callback: () => void, intervalMs: number): unknown {
    const handle = setInterval(callback, intervalMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle: unknown): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class HostSuspendDetector {
  private readonly options: Required<Omit<HostSuspendDetectorOptions, "onSuspend">> & {
    onSuspend: (suspendedMs: number) => void;
  };
  private handle: unknown = null;
  private lastWall = 0;
  private lastMonotonic = 0;

  constructor(options: HostSuspendDetectorOptions) {
    this.options = {
      onSuspend: options.onSuspend,
      intervalMs: options.intervalMs ?? HOST_SUSPEND_CHECK_INTERVAL_MS,
      thresholdMs: options.thresholdMs ?? HOST_SUSPEND_THRESHOLD_MS,
      wallNow: options.wallNow ?? Date.now,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      timers: options.timers ?? systemIntervals,
    };
  }

  /** Idempotent while started. */
  start(): void {
    if (this.handle !== null) return;
    this.mark();
    this.handle = this.options.timers.setInterval(() => this.check(), this.options.intervalMs);
  }

  /** Idempotent; a late tick after stop does nothing. */
  stop(): void {
    if (this.handle === null) return;
    this.options.timers.clearInterval(this.handle);
    this.handle = null;
  }

  /** Compares the clocks now. Exposed for tests; the interval calls it. */
  check(): void {
    if (this.handle === null) return;
    const wall = this.options.wallNow();
    const monotonic = this.options.monotonicNow();
    const drift = wall - this.lastWall - (monotonic - this.lastMonotonic);
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    if (!(drift >= this.options.thresholdMs)) return;
    try {
      this.options.onSuspend(drift);
    } catch (error) {
      console.warn(
        "[backend] Failed to reconcile due work after a host suspension:",
        error instanceof Error ? error.name : "unknown",
      );
    }
  }

  private mark(): void {
    this.lastWall = this.options.wallNow();
    this.lastMonotonic = this.options.monotonicNow();
  }
}
