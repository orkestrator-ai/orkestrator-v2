/**
 * One in-flight promise per key: a second caller for the same key joins the
 * first instead of starting its own work. The entry is dropped once the work
 * settles, so the next caller starts afresh.
 */
export class KeyedSingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const flight = start().finally(() => {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    });
    this.inFlight.set(key, flight);
    return flight;
  }

  /** Resolves once nothing is in flight, including work started while waiting. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight.values());
    }
  }
}
