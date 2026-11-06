/**
 * Tracks hydration work through projection installation, including failed parts
 * of successful batch RPCs. Retains only counters, never errors or record data.
 * This is diagnostic state; backend-owned work continues independently.
 */
class HydrationActivity {
  pending = 0;
  started = 0;
  failed = false;
  private idleWaiters: Array<() => void> = [];

  async track<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    this.started++;
    try {
      return await task();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.pending--;
      if (this.pending === 0) this.resolveIdle();
    }
  }

  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  resetForTests(): void {
    this.pending = 0;
    this.started = 0;
    this.failed = false;
    this.resolveIdle();
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** One per renderer document, as with the hydration request limiter. */
export const hydrationActivity = new HydrationActivity();
