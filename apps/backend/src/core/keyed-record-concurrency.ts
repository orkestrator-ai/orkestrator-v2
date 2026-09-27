/**
 * Small in-process concurrency primitives for the keyed record store.
 *
 * Deliberately separate from `StorageBase.enqueueWrite`: that queue serializes
 * every JSON write in the process, so one slow large write would block every
 * other record. Here different keys progress independently and only the
 * staging of payload bytes is bounded, by count and by bytes.
 */

export class KeyedRecordAdmissionError extends Error {
  constructor(message = "Keyed record store is at its admission limit") {
    super(message);
    this.name = "KeyedRecordAdmissionError";
  }
}

/** Serializes operations per key; distinct keys run concurrently. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, number>();

  isBusy(key: string): boolean {
    return (this.active.get(key) ?? 0) > 0;
  }

  get size(): number {
    return this.tails.size;
  }

  /** Resolves once every operation queued before this call has settled. */
  async settled(): Promise<void> {
    await Promise.all(Array.from(this.tails.values()));
  }

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.finally(() => {
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining <= 0) this.active.delete(key);
      else this.active.set(key, remaining);
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}

/**
 * Count-and-byte semaphore with a bounded waiter list. A request larger than
 * the byte budget is admitted alone (when nothing else holds bytes) so a
 * single maximal record cannot deadlock; admission never becomes an
 * unbounded promise tail because excess waiters are rejected immediately.
 */
export class ByteCountSemaphore {
  private count = 0;
  private bytes = 0;
  private readonly waiters: Array<{ bytes: number; resolve: (release: () => void) => void }> = [];

  constructor(
    private readonly maxCount: number,
    private readonly maxBytes: number,
    private readonly maxWaiters: number,
  ) {
    if (maxCount < 1 || maxBytes < 1 || maxWaiters < 0) {
      throw new Error("Semaphore limits must be positive");
    }
  }

  get inFlightCount(): number {
    return this.count;
  }

  get inFlightBytes(): number {
    return this.bytes;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  private fits(bytes: number): boolean {
    if (this.count >= this.maxCount) return false;
    return this.count === 0 || this.bytes + bytes <= this.maxBytes;
  }

  acquire(bytes: number): Promise<() => void> {
    if (this.waiters.length === 0 && this.fits(bytes)) return Promise.resolve(this.grant(bytes));
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(new KeyedRecordAdmissionError());
    }
    return new Promise((resolve) => this.waiters.push({ bytes, resolve }));
  }

  private grant(bytes: number): () => void {
    this.count += 1;
    this.bytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count -= 1;
      this.bytes -= bytes;
      this.pump();
    };
  }

  private pump(): void {
    // Grants are taken synchronously, so a waiter's slot is accounted before
    // the next waiter is considered: FIFO without over-admission.
    while (this.waiters.length > 0 && this.fits(this.waiters[0]!.bytes)) {
      const waiter = this.waiters.shift()!;
      waiter.resolve(this.grant(waiter.bytes));
    }
  }
}

/** Minimal in-process mutex for short metadata critical sections. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
