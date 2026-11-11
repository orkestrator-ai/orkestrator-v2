/**
 * The silence watchdog shared by both OpenCode event monitors: the 1.x
 * provider's `/event` stream (`opencode-observation-stream.ts`) and the 2.x
 * provider's `/api/event` stream (`opencode2/provider.ts`). It has no
 * dependencies so the 2.x provider can use it without loading 1.x modules.
 */

/**
 * Longest silence an OpenCode event stream may have once it has proved it
 * heartbeats. `opencode serve` writes `server.heartbeat` every 10 s (observed
 * against 1.19.5), so this is three missed heartbeats plus slack for a busy
 * event loop on either side.
 */
export const OPENCODE_EVENT_STREAM_SILENCE_MS = 35_000;

/**
 * The same deadline for the 2.x `/api/event` stream. `opencode serve` 2.2.6
 * writes a `: heartbeat` SSE comment on connect and then every 15 s (measured
 * 2026-11-11 on Linux x64, unbuffered, idle server), so this is three missed
 * heartbeats plus the same 5 s of slack as the 1.x deadline.
 */
export const OPENCODE2_EVENT_STREAM_SILENCE_MS = 50_000;

/** The time source and timers a silence watchdog runs on; tests substitute a fake. */
export interface OpenCodeSilenceClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface OpenCodeSilenceOptions {
  silenceMs?: number;
  clock?: OpenCodeSilenceClock;
}

const REAL_SILENCE_CLOCK: OpenCodeSilenceClock = {
  now: () => performance.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    // A deadline must never hold the process open on its own.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Notices an OpenCode event stream that stays open but goes quiet, so the
 * monitor replaces it instead of trusting frozen activity until TCP gives up.
 *
 * One watchdog per connection. It is armed by the first heartbeat (1.x's
 * `server.heartbeat` frame, 2.x's `: heartbeat` comment): a server that never
 * heartbeats (an OpenCode that predates the frame) is legitimately silent
 * while idle, and a deadline there would reconnect it forever. Once armed,
 * any frame (for 2.x, any bytes) counts as life. The timer re-checks the
 * elapsed silence rather than restarting on every frame, so a busy stream
 * costs no timer churn. `stop()` is the owner's explicit cancel (AGENTS.md
 * invariant 15); the monitor calls it whenever the connection ends.
 */
export class OpenCodeStreamSilenceWatchdog {
  private lastFrameAt = 0;
  private armed = false;
  private stopped = false;
  private timer: unknown;
  private readonly silenceMs: number;
  private readonly clock: OpenCodeSilenceClock;

  constructor(
    private readonly onSilent: (silenceMs: number) => void,
    options: OpenCodeSilenceOptions = {},
  ) {
    this.silenceMs = Math.max(1, options.silenceMs ?? OPENCODE_EVENT_STREAM_SILENCE_MS);
    this.clock = options.clock ?? REAL_SILENCE_CLOCK;
  }

  get isArmed(): boolean {
    return this.armed && !this.stopped;
  }

  /** A frame arrived; a heartbeat arms the deadline. */
  frame(heartbeat: boolean): void {
    if (this.stopped) return;
    this.lastFrameAt = this.clock.now();
    if (heartbeat && !this.armed) {
      this.armed = true;
      this.schedule(this.silenceMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    this.timer = this.clock.setTimer(() => this.check(), delayMs);
  }

  private check(): void {
    this.timer = undefined;
    if (this.stopped) return;
    const silentFor = this.clock.now() - this.lastFrameAt;
    if (silentFor < this.silenceMs) {
      this.schedule(this.silenceMs - silentFor);
      return;
    }
    this.stop();
    this.onSilent(this.silenceMs);
  }
}
