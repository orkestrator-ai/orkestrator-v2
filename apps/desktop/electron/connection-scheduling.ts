/**
 * Background connection scheduling for the connection manager: a bound on
 * concurrent background attempts across machines, and per-machine reconnect
 * timers with a capped backoff. User-initiated connects never wait here.
 */

export class BackgroundAttemptLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

/** One pending reconnect per machine; delays grow per attempt and reset on success. */
export class ReconnectScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly delaysMs: readonly number[],
    private readonly fire: (connectionId: string) => void,
  ) {}

  schedule(connectionId: string): void {
    if (this.disposed || this.timers.has(connectionId)) return;
    const attempt = (this.attempts.get(connectionId) ?? 0) + 1;
    this.attempts.set(connectionId, attempt);
    const delay = this.delaysMs[Math.min(attempt - 1, this.delaysMs.length - 1)] ?? 60_000;
    const timer = setTimeout(() => {
      this.timers.delete(connectionId);
      this.fire(connectionId);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(connectionId, timer);
  }

  cancel(connectionId: string): void {
    const timer = this.timers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(connectionId);
    this.attempts.delete(connectionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempts.clear();
  }
}
