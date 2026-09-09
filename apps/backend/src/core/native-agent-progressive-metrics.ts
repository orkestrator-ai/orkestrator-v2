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

const MAX_METRICS = 256;

export class ProgressiveReadMetrics {
  private readonly samples: ProgressiveReadMetric[] = [];

  record(metric: ProgressiveReadMetric): void {
    this.samples.push({
      ...metric,
      durationMs: Math.max(0, Math.round(metric.durationMs)),
      ...(metric.schedulerWaitMs === undefined
        ? {}
        : { schedulerWaitMs: Math.max(0, Math.round(metric.schedulerWaitMs)) }),
      ...(metric.sourceMs === undefined ? {} : { sourceMs: Math.max(0, Math.round(metric.sourceMs)) }),
      ...(metric.normalizeMs === undefined
        ? {}
        : { normalizeMs: Math.max(0, Math.round(metric.normalizeMs)) }),
    });
    if (this.samples.length > MAX_METRICS) this.samples.splice(0, this.samples.length - MAX_METRICS);
  }

  list(): readonly ProgressiveReadMetric[] {
    return this.samples;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export function monotonicMs(now: () => number = Date.now): number {
  return now();
}
