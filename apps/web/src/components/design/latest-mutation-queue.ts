/** Serializes mutations while retaining the newest pending request per resource. */
export class LatestMutationQueue<T> {
  private readonly pending = new Map<string, T>();
  private draining: Promise<void> | null = null;

  constructor(
    private readonly run: (value: T) => Promise<void>,
    private readonly onBusy: (busy: boolean) => void = () => {},
  ) {}

  enqueue(key: string, value: T): void {
    this.pending.set(key, value);
    this.start();
  }

  private start(): void {
    if (this.draining || this.pending.size === 0) return;
    this.onBusy(true);
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.onBusy(false);
      this.start();
    });
  }

  async flush(): Promise<void> {
    await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const next = this.pending.entries().next().value as [string, T] | undefined;
      if (!next) return;
      this.pending.delete(next[0]);
      await this.run(next[1]);
    }
  }
}
