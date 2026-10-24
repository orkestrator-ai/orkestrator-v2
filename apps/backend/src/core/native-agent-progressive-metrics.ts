/**
 * In-process progressive-read timings. Labels stay bounded and never include
 * prompts, paths, credentials, or session identifiers.
 */
export type ProgressiveReadDomain = "transcript" | "state" | "discovery";
export type ProgressiveCacheTier = "memory" | "persisted" | "provider" | "degraded";
export type ProgressiveReadOutcome =
  | "snapshot"
  | "delta"
  | "unchanged"
  | "cached"
  | "missing"
  | "unavailable";

export interface ProgressiveReadMetric {
  domain: ProgressiveReadDomain;
  cacheTier: ProgressiveCacheTier;
  outcome: ProgressiveReadOutcome;
  durationMs: number;
  schedulerWaitMs?: number;
  sourceMs?: number;
  normalizeMs?: number;
  joined?: boolean;
  degraded?: boolean;
}

/** Kept per domain: idle views poll state and discovery far more often than transcripts change. */
const MAX_METRICS_PER_DOMAIN = 256;

export class ProgressiveReadMetrics {
  private readonly samplesByDomain = new Map<ProgressiveReadDomain, ProgressiveReadMetric[]>();

  record(metric: ProgressiveReadMetric): void {
    let samples = this.samplesByDomain.get(metric.domain);
    if (!samples) {
      samples = [];
      this.samplesByDomain.set(metric.domain, samples);
    }
    samples.push({
      ...metric,
      durationMs: Math.max(0, Math.round(metric.durationMs)),
      ...(metric.schedulerWaitMs === undefined
        ? {}
        : { schedulerWaitMs: Math.max(0, Math.round(metric.schedulerWaitMs)) }),
      ...(metric.sourceMs === undefined
        ? {}
        : { sourceMs: Math.max(0, Math.round(metric.sourceMs)) }),
      ...(metric.normalizeMs === undefined
        ? {}
        : { normalizeMs: Math.max(0, Math.round(metric.normalizeMs)) }),
    });
    if (samples.length > MAX_METRICS_PER_DOMAIN)
      samples.splice(0, samples.length - MAX_METRICS_PER_DOMAIN);
  }

  /** Every domain's samples, oldest first within a domain. */
  list(domain?: ProgressiveReadDomain): readonly ProgressiveReadMetric[] {
    if (domain) return this.samplesByDomain.get(domain) ?? [];
    return [...this.samplesByDomain.values()].flat();
  }

  clear(): void {
    this.samplesByDomain.clear();
  }
}

/**
 * A monotonic millisecond clock for durations. `Date.now` can step backwards
 * or jump under NTP adjustment, which would record negative or inflated read
 * durations; wall-clock timestamps stay on the service's injected `now`.
 */
export function monotonicMs(now: () => number = () => performance.now()): number {
  return now();
}

export type ProgressiveReadPhases = Pick<
  ProgressiveReadMetric,
  "schedulerWaitMs" | "sourceMs" | "normalizeMs" | "joined"
>;

/**
 * Splits one progressive read into where its time went:
 *
 * - `sourceMs`: awaiting the provider read itself.
 * - `normalizeMs`: projecting what the provider returned and committing it —
 *   the synchronous work between the provider's answer and the response.
 * - `schedulerWaitMs`: time inside the shared-read scheduler that was not this
 *   caller's own read — joining another caller's in-flight read, or waiting
 *   for a trailing read. A caller whose own read never ran is `joined`.
 *
 * Session resolution and delta encoding belong to none of them, so the phases
 * sum to at most `durationMs`. Only durations are kept; never a payload.
 */
export class ProgressiveReadPhaseTimer {
  private sourceMs = 0;
  private normalizeMs = 0;
  private ownMs = 0;
  private coveringMs = 0;
  private sourceStartedAt: number | undefined;
  private sourceEndedAt: number | undefined;
  private ran = false;

  constructor(private readonly clock: () => number = monotonicMs) {}

  /** Wraps this caller's read closure: time inside it is the caller's own work. */
  own<T>(read: () => Promise<T>): () => Promise<T> {
    return async () => {
      this.ran = true;
      this.sourceEndedAt = undefined;
      const startedAt = this.clock();
      try {
        return await read();
      } finally {
        const endedAt = this.clock();
        this.ownMs += endedAt - startedAt;
        // Everything after the provider answered is projection work.
        if (this.sourceEndedAt !== undefined) this.normalizeMs += endedAt - this.sourceEndedAt;
        this.sourceEndedAt = undefined;
      }
    };
  }

  /** Brackets the awaited provider read; call `sourceEnded` as soon as it returns. */
  sourceStarted(): void {
    this.sourceStartedAt = this.clock();
  }

  sourceEnded(): void {
    if (this.sourceStartedAt === undefined) return;
    const endedAt = this.clock();
    this.sourceMs += endedAt - this.sourceStartedAt;
    this.sourceStartedAt = undefined;
    this.sourceEndedAt = endedAt;
  }

  /** Times the shared-read scheduler call, including any joined or trailing read. */
  async covering<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = this.clock();
    try {
      return await run();
    } finally {
      this.coveringMs += this.clock() - startedAt;
    }
  }

  /** Times synchronous normalization done outside the read closure. */
  normalize<T>(work: () => T): T {
    const startedAt = this.clock();
    try {
      return work();
    } finally {
      this.normalizeMs += this.clock() - startedAt;
    }
  }

  phases(): ProgressiveReadPhases {
    return {
      schedulerWaitMs: Math.max(0, this.coveringMs - this.ownMs),
      sourceMs: this.sourceMs,
      normalizeMs: this.normalizeMs,
      ...(this.ran ? {} : { joined: true }),
    };
  }
}
