import { createLogger, type LogEventOf } from "@orkestrator/protocol/logger";

const log = createLogger("transcript-artifacts");

/**
 * Content-free counters for transcript artifacts.
 *
 * Series names are fixed labels plus bounded enum values (kind, outcome,
 * error code). No ids, titles, sources, hashes or grants are ever recorded,
 * and the number of series is capped so a bug cannot grow memory without
 * bound. Read through `get_artifact_metrics` and the diagnostics bundle. A failed
 * operation also logs its reason code, so a deadline is not counted here too.
 * Operational logs use `logArtifactEvent`, which accepts only ids, kinds, sizes,
 * durations and reason codes.
 */
const MAX_SERIES = 256;
const LABEL = /^[a-z0-9_.:-]{1,64}$/;

export type ArtifactCounter =
  | "operations"
  | "receipts"
  | "receipt_mismatches"
  | "publications"
  | "blocked_requests"
  | "worker_deaths"
  | "repairs"
  | "repair_budget_exhausted"
  | "transient_retries"
  | "storage_corrupt"
  | "interrupted_recoveries"
  | "gc_assets_removed"
  | "gc_staging_removed"
  | "gc_drafts_expired"
  | "late_completions_discarded"
  | "search_text_unstored";

function segment(value: string): string {
  return LABEL.test(value) ? value : "other";
}

export class ArtifactMetrics {
  private readonly counters = new Map<string, number>();
  private dropped = 0;

  increment(counter: ArtifactCounter, labels: Record<string, string> = {}, by = 1): void {
    const key = [
      counter,
      ...Object.entries(labels)
        .sort()
        .map(([k, v]) => `${segment(k)}=${segment(v)}`),
    ].join("|");
    if (!this.counters.has(key) && this.counters.size >= MAX_SERIES) {
      this.dropped += 1;
      return;
    }
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(counter: ArtifactCounter, labels: Record<string, string> = {}): number {
    const key = [
      counter,
      ...Object.entries(labels)
        .sort()
        .map(([k, v]) => `${segment(k)}=${segment(v)}`),
    ].join("|");
    return this.counters.get(key) ?? 0;
  }

  total(counter: ArtifactCounter): number {
    let sum = 0;
    for (const [key, value] of this.counters) {
      if (key === counter || key.startsWith(`${counter}|`)) sum += value;
    }
    return sum;
  }

  snapshot(): { counters: Record<string, number>; droppedSeries: number } {
    return { counters: Object.fromEntries(this.counters), droppedSeries: this.dropped };
  }
}

/** Logs a content-free event: identifiers, kinds, sizes, durations and reason codes only. */
export function logArtifactEvent(
  event: LogEventOf<"transcript-artifacts">,
  fields: Record<string, string | number | boolean | undefined>,
  level: "warn" | "info" = "warn",
): void {
  log[level](event, () => {
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) safe[key] = typeof value === "string" ? value.slice(0, 80) : value;
    }
    return safe;
  });
}
