import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("web.native-agent");

/** First retry delay after a failed draft write; doubles per attempt. */
export const DRAFT_RETRY_BASE_MS = 1_000;
/** Longest wait between timed retries. */
export const DRAFT_RETRY_CEILING_MS = 30_000;
/**
 * Timed attempts before a write waits for the next reconnect, read or write
 * on its key instead. About two minutes of retrying at the defaults.
 */
export const DRAFT_RETRY_TIMER_ATTEMPTS = 8;
/** Draft keys with a write awaiting retry, per node. The oldest is dropped past it. */
export const DRAFT_RETRY_MAX_KEYS = 128;

export interface DraftRetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: DraftRetryClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DraftWriteRetriesOptions {
  /** Runs `operation` on the key's serialized write chain. */
  enqueue(draftKey: string, operation: () => Promise<void>): Promise<void>;
  /** Whether a failure could succeed on a later attempt (not a revision conflict). */
  isRetryable(error: unknown): boolean;
  /** Whether the node is known to be unreachable, so a timed attempt would only fail. */
  isDisconnected(): boolean;
  clock?: DraftRetryClock;
}

interface PendingWrite {
  readonly seq: number;
  readonly run: () => Promise<void>;
  attempts: number;
  timer: unknown;
  exhausted: boolean;
}

/** Live instances, so tests can cancel every timer between cases. */
const liveRetries = new Set<DraftWriteRetries>();

/** The draft's namespace (`native-claude`, `kanban-task`, …); never the key's ids. */
function namespaceOf(draftKey: string): string {
  const separator = draftKey.indexOf(":");
  return separator > 0 ? draftKey.slice(0, separator) : "unknown";
}

/**
 * Retries a failed compose-draft save or discard until it lands.
 *
 * A saved draft holds the backend's queue drain and agent mail for that tab
 * (`composeDraftHoldsQueue`), so a discard that fails during a dropped
 * connection used to leave a stale draft holding the queue with nothing on
 * screen to say why. Each failure here is retried with the value the caller
 * asked for, at once when the node reconnects, and before any later read of
 * the key, so a reopened tab does not hydrate the draft it already submitted.
 *
 * The latest write for a key always wins. A new save or discard cancels the
 * key's pending retry when it is issued; a failure is kept only if no newer
 * write was issued in the meantime; a queued retry that a newer write
 * overtook does nothing. Revision conflicts are never retried: they need the
 * user's choice, which the next edit asks for.
 *
 * Bounds: one pending write per key, {@link DRAFT_RETRY_MAX_KEYS} keys, one
 * timer per pending write, {@link DRAFT_RETRY_TIMER_ATTEMPTS} timed attempts.
 */
export class DraftWriteRetries {
  private readonly clock: DraftRetryClock;
  /** The newest write issued per key that has not yet succeeded. */
  private readonly latest = new Map<string, number>();
  private readonly pending = new Map<string, PendingWrite>();
  private seq = 0;
  private disposed = false;

  constructor(private readonly options: DraftWriteRetriesOptions) {
    this.clock = options.clock ?? realClock;
    liveRetries.add(this);
  }

  /** A write was issued for `draftKey`; it supersedes any pending retry. */
  begin(draftKey: string): number {
    this.cancelPending(draftKey);
    this.seq += 1;
    this.latest.set(draftKey, this.seq);
    return this.seq;
  }

  /**
   * The write `seq` settled. `run` repeats it; it is called only from the
   * key's write chain.
   */
  settled(
    draftKey: string,
    seq: number,
    outcome: { error: unknown } | null,
    run: () => Promise<void>,
  ): void {
    if (this.disposed || this.latest.get(draftKey) !== seq) return;
    if (!outcome) {
      this.latest.delete(draftKey);
      return;
    }
    if (!this.options.isRetryable(outcome.error)) {
      this.latest.delete(draftKey);
      return;
    }
    if (!this.pending.has(draftKey) && this.pending.size >= DRAFT_RETRY_MAX_KEYS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.cancelPending(oldest);
        this.latest.delete(oldest);
        log.warn("compose-draft.retry-abandoned", {
          source: namespaceOf(oldest),
          reason: "capacity",
        });
      }
    }
    const entry: PendingWrite = { seq, run, attempts: 1, timer: null, exhausted: false };
    this.pending.set(draftKey, entry);
    this.armTimer(draftKey, entry);
  }

  /**
   * Run the key's pending write, if any, before a read or read-modify-write.
   * Must be called from inside the key's write chain.
   */
  async flushInline(draftKey: string): Promise<void> {
    const entry = this.pending.get(draftKey);
    if (!entry) return;
    this.clearTimer(entry);
    await this.attempt(draftKey, entry);
  }

  /** The node reconnected: try every pending write now, with a fresh budget. */
  retryNow(): void {
    if (this.disposed) return;
    for (const [draftKey, entry] of Array.from(this.pending)) {
      this.clearTimer(entry);
      entry.attempts = 0;
      entry.exhausted = false;
      void this.options
        .enqueue(draftKey, () => this.attempt(draftKey, entry))
        .catch(() => undefined);
    }
  }

  /** Keys with a write awaiting retry. */
  pendingKeys(): string[] {
    return Array.from(this.pending.keys());
  }

  /** Forget every pending write and timer; the instance stays usable. */
  cancelAll(): void {
    for (const entry of this.pending.values()) this.clearTimer(entry);
    this.pending.clear();
    this.latest.clear();
  }

  dispose(): void {
    this.cancelAll();
    this.disposed = true;
    liveRetries.delete(this);
  }

  private async attempt(draftKey: string, entry: PendingWrite): Promise<void> {
    if (this.disposed || this.pending.get(draftKey) !== entry) return;
    try {
      await entry.run();
    } catch (error) {
      if (this.pending.get(draftKey) !== entry) return;
      if (!this.options.isRetryable(error)) {
        this.pending.delete(draftKey);
        if (this.latest.get(draftKey) === entry.seq) this.latest.delete(draftKey);
        log.warn("compose-draft.retry-abandoned", {
          source: namespaceOf(draftKey),
          reason: "conflict",
        });
        return;
      }
      entry.attempts += 1;
      this.armTimer(draftKey, entry);
      return;
    }
    if (this.pending.get(draftKey) !== entry) return;
    this.pending.delete(draftKey);
    if (this.latest.get(draftKey) === entry.seq) this.latest.delete(draftKey);
    log.info("compose-draft.retry-recovered", {
      source: namespaceOf(draftKey),
      attempts: entry.attempts,
    });
  }

  private armTimer(draftKey: string, entry: PendingWrite): void {
    if (this.disposed) return;
    this.clearTimer(entry);
    if (entry.attempts > DRAFT_RETRY_TIMER_ATTEMPTS) {
      if (!entry.exhausted) {
        entry.exhausted = true;
        log.warn("compose-draft.retry-abandoned", {
          source: namespaceOf(draftKey),
          reason: "attempts",
          attempts: entry.attempts - 1,
        });
      }
      return;
    }
    const delayMs = Math.min(
      DRAFT_RETRY_CEILING_MS,
      DRAFT_RETRY_BASE_MS * 2 ** Math.min(entry.attempts - 1, 8),
    );
    entry.timer = this.clock.setTimeout(() => {
      entry.timer = null;
      if (this.pending.get(draftKey) !== entry) return;
      if (this.options.isDisconnected()) {
        // An attempt now would only fail. Wait for the reconnect, which
        // retries at once, without spending the budget; the timer stays as a
        // fallback in case that signal never arrives.
        entry.timer = this.clock.setTimeout(() => {
          entry.timer = null;
          this.retryEntry(draftKey, entry);
        }, DRAFT_RETRY_CEILING_MS);
        return;
      }
      this.retryEntry(draftKey, entry);
    }, delayMs);
  }

  private retryEntry(draftKey: string, entry: PendingWrite): void {
    if (this.pending.get(draftKey) !== entry) return;
    void this.options.enqueue(draftKey, () => this.attempt(draftKey, entry)).catch(() => undefined);
  }

  private cancelPending(draftKey: string): void {
    const entry = this.pending.get(draftKey);
    if (!entry) return;
    this.clearTimer(entry);
    this.pending.delete(draftKey);
  }

  private clearTimer(entry: PendingWrite): void {
    if (entry.timer === null) return;
    this.clock.clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** Test seam: cancels every live instance's pending writes and timers. */
export function cancelAllDraftWriteRetriesForTests(): void {
  for (const retries of liveRetries) retries.cancelAll();
}
