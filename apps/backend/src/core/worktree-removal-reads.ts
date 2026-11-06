import { PhysicalKeyResolver } from "./change-tracking/index.js";
import type { WorktreeLookup } from "./worktree-adhoc-reads.js";

/** Owns readers independently of the ad hoc join cache, which invalidation can drop. */
export class WorktreeRemovalReads {
  private readonly keys = new PhysicalKeyResolver();
  private readonly removing = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();

  key(lookup: WorktreeLookup): string {
    return this.keys.key({ ...lookup, kind: lookup.worktreePath ? "local" : "container" });
  }

  assertReadable(lookup: WorktreeLookup): void {
    if (this.removing.has(this.key(lookup))) throw new Error("The worktree is being removed");
  }

  canTrack(lookup: WorktreeLookup): boolean {
    const key = this.key(lookup);
    return !this.removing.has(key) || this.completed.has(key);
  }

  /** Only authoritative tracking of a replacement may retire a completed fence. */
  track(lookup: WorktreeLookup): void {
    const key = this.key(lookup);
    if (this.completed.delete(key)) this.removing.delete(key);
    this.assertReadable(lookup);
  }

  complete(lookup: WorktreeLookup): void {
    const key = this.key(lookup);
    if (this.removing.has(key)) this.completed.add(key);
  }

  run<T>(lookup: WorktreeLookup, read: () => Promise<T>): Promise<T> {
    this.assertReadable(lookup);
    const key = this.key(lookup);
    const reads = this.pending.get(key) ?? new Set<Promise<unknown>>();
    this.pending.set(key, reads);
    // Register before starting, including reads waiting for admission or refresh.
    const { promise: pending, resolve, reject } = Promise.withResolvers<T>();
    reads.add(pending);
    const clear = () => {
      reads.delete(pending);
      if (reads.size === 0) this.pending.delete(key);
    };
    pending.then(clear, clear);
    // Starting synchronously preserves the snapshot owner's admission timing.
    try {
      read().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return pending;
  }

  async close(lookup: WorktreeLookup): Promise<void> {
    const key = this.key(lookup);
    this.completed.delete(key);
    this.removing.add(key);
    await Promise.allSettled(Array.from(this.pending.get(key) ?? []));
  }
}
