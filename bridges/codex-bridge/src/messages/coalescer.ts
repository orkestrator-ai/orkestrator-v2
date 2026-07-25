/**
 * Bounded-cadence publisher for UI snapshots.
 *
 * app-server streams token-level deltas. Forwarding every one to React would be
 * far more traffic than the pre-migration bridge produced (which published whole
 * message snapshots) and would spend the browser's frame budget on renders the
 * user cannot perceive.
 *
 * So: consume every delta internally, publish at a bounded rate, and flush
 * *immediately* on the events that matter — item completion, turn completion,
 * errors. Because each publish is a full normalized snapshot rather than a patch,
 * a dropped intermediate frame is unobservable; the next one is complete.
 */
export interface CoalescerOptions {
  /** Minimum gap between scheduled publishes. */
  intervalMs?: number;
  publish: () => Promise<void> | void;
  onError?: (error: unknown) => void;
}

/** ~60fps is pointless for text; this is roughly perceptual for streaming prose. */
export const DEFAULT_COALESCE_INTERVAL_MS = 100;

export class UpdateCoalescer {
  private readonly intervalMs: number;
  private readonly publish: () => Promise<void> | void;
  private readonly onError?: (error: unknown) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private publishing = false;
  private runPromise: Promise<void> | null = null;
  /** A change arrived while a publish was in flight. */
  private dirty = false;
  private stopped = false;
  private lastPublishedAt = 0;
  private coalescedCount = 0;
  private publishedCount = 0;

  constructor(options: CoalescerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_COALESCE_INTERVAL_MS;
    this.publish = options.publish;
    this.onError = options.onError;
  }

  getMetrics(): { coalesced: number; published: number } {
    return { coalesced: this.coalescedCount, published: this.publishedCount };
  }

  /** Records a change; publishes on the next cadence tick. */
  schedule(now: number = Date.now()): void {
    if (this.stopped) return;
    this.coalescedCount += 1;

    if (this.publishing) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;

    const elapsed = now - this.lastPublishedAt;
    const delay = elapsed >= this.intervalMs ? 0 : this.intervalMs - elapsed;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Publishes right now, bypassing the cadence.
   *
   * Used for terminal events: waiting up to an interval to show a completed turn
   * would make the UI feel laggy exactly when it matters most.
   */
  async flushNow(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.run();
  }

  private run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.runPromise) {
      // A concurrent flush is already publishing. Its caller must not resolve
      // until the follow-up snapshot containing this change has been sent.
      this.dirty = true;
      return this.runPromise;
    }

    // Install the shared promise before invoking publish. A synchronous publish
    // callback can re-enter flushNow(), which must join this run.
    let resolveRun!: () => void;
    let rejectRun!: (error: unknown) => void;
    const activeRun = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    this.runPromise = activeRun;
    void this.runLoop().then(
      () => {
        this.runPromise = null;
        resolveRun();
      },
      (error) => {
        this.runPromise = null;
        rejectRun(error);
      },
    );
    return activeRun;
  }

  private async runLoop(): Promise<void> {
    do {
      this.publishing = true;
      this.dirty = false;
      try {
        await this.publish();
        this.publishedCount += 1;
        this.lastPublishedAt = Date.now();
      } catch (error) {
        this.onError?.(error);
      } finally {
        this.publishing = false;
      }
      // Changes received during the awaited publish are already absent from
      // that snapshot. Publish their full replacement before resolving a flush.
    } while (this.dirty && !this.stopped);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }
}
