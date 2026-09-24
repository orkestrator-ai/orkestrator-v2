/**
 * Fair, bounded selection of unstarted design render jobs.
 *
 * Policy: the best effective priority wins (interactive > validation >
 * background). A job is promoted one class for every `agingMs` it waits, so
 * background and validation work cannot starve. Ties go to the environment,
 * then the canvas, that was served least recently (round-robin), and finally to
 * submission order. One environment flooding the queue therefore cannot delay
 * another environment by more than one job per worker at equal priority.
 */
export type DesignRenderPriority = "interactive" | "validation" | "background";

const PRIORITY_RANK: Record<DesignRenderPriority, number> = {
  interactive: 0,
  validation: 1,
  background: 2,
};

export const DESIGN_RENDER_AGING_MS = 2_000;

export interface DesignRenderQueueEntry {
  environmentId: string;
  canvasId: string;
  priority: DesignRenderPriority;
  enqueuedAt: number;
}

export class DesignRenderQueue<E extends DesignRenderQueueEntry> {
  private readonly entries: E[] = [];
  private readonly served = new Map<string, number>();
  private serveCounter = 0;

  constructor(private readonly agingMs = DESIGN_RENDER_AGING_MS) {}

  get size(): number {
    return this.entries.length;
  }

  push(entry: E): void {
    this.entries.push(entry);
  }

  /** Removes an unstarted entry; false when it was already taken. */
  remove(entry: E): boolean {
    const index = this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.prune();
    return true;
  }

  /** Removes and returns every unstarted entry. */
  drain(): E[] {
    const drained = this.entries.splice(0);
    this.served.clear();
    return drained;
  }

  /** Takes the next entry to execute under the fairness policy. */
  take(now: number): E | undefined {
    let best: E | undefined;
    let bestKey: number[] = [];
    for (const [index, entry] of this.entries.entries()) {
      const key = [
        this.effectiveRank(entry, now),
        this.served.get(envKey(entry)) ?? 0,
        this.served.get(canvasKey(entry)) ?? 0,
        index,
      ];
      if (!best || compare(key, bestKey) < 0) {
        best = entry;
        bestKey = key;
      }
    }
    if (!best) return undefined;
    this.entries.splice(bestKey[3]!, 1);
    const stamp = ++this.serveCounter;
    this.served.set(envKey(best), stamp);
    this.served.set(canvasKey(best), stamp);
    this.prune();
    return best;
  }

  effectiveRank(entry: DesignRenderQueueEntry, now: number): number {
    const promotions = this.agingMs > 0 ? Math.floor((now - entry.enqueuedAt) / this.agingMs) : 0;
    return Math.max(0, PRIORITY_RANK[entry.priority] - Math.max(0, promotions));
  }

  /** Forget service stamps for lanes with no queued work so the map stays bounded. */
  private prune(): void {
    if (this.served.size <= this.entries.length * 2 + 32) return;
    const live = new Set<string>();
    for (const entry of this.entries) {
      live.add(envKey(entry));
      live.add(canvasKey(entry));
    }
    for (const key of Array.from(this.served.keys())) if (!live.has(key)) this.served.delete(key);
  }
}

function envKey(entry: DesignRenderQueueEntry): string {
  return `e:${entry.environmentId}`;
}

function canvasKey(entry: DesignRenderQueueEntry): string {
  return `c:${entry.environmentId}\u0000${entry.canvasId}`;
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Deadline helpers shared by the renderer. Each owns its rejection paths.

/** Resolves true when the promise settles within ms; false on timeout. Never rejects. */
export function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/** Converts synchronous throws into rejections so every failure has one path. */
export function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(asError(error));
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
