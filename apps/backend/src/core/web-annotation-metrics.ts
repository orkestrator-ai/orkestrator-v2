/**
 * Bounded, content-free operational metrics for web annotations.
 *
 * Series names are built only from closed vocabularies: command names from
 * the registry, request states and operations, error codes, storage scopes,
 * and fixed outcome words. Ids, text, URLs, selectors, paths, and raw error
 * messages are never recorded, so a snapshot can be exported as-is.
 */
import {
  WEB_ANNOTATION_METRIC_BUCKETS_MS,
  type WebAnnotationDurationSummary,
  type WebAnnotationMetricsSnapshot,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationCommitObservation } from "./web-annotation-storage.js";

const MAX_SERIES = 512;

function segment(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
}

function sinceMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export class WebAnnotationMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, WebAnnotationDurationSummary>();
  private readonly gauges = new Map<string, number>();
  private droppedSeries = 0;

  private hasRoom(map: Map<string, unknown>, key: string): boolean {
    if (map.has(key)) return true;
    if (this.counters.size + this.durations.size + this.gauges.size >= MAX_SERIES) {
      this.droppedSeries++;
      return false;
    }
    return true;
  }

  increment(name: string, by = 1): void {
    if (!this.hasRoom(this.counters, name)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (!this.hasRoom(this.durations, name)) return;
    const summary = this.durations.get(name) ?? {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: Array.from({ length: WEB_ANNOTATION_METRIC_BUCKETS_MS.length + 1 }, () => 0),
    };
    summary.count++;
    summary.totalMs += ms;
    summary.maxMs = Math.max(summary.maxMs, ms);
    let bucket = WEB_ANNOTATION_METRIC_BUCKETS_MS.findIndex((bound) => ms <= bound);
    if (bucket < 0) bucket = WEB_ANNOTATION_METRIC_BUCKETS_MS.length;
    for (let index = bucket; index < summary.buckets.length; index++) summary.buckets[index]!++;
    this.durations.set(name, summary);
  }

  gauge(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    if (!this.hasRoom(this.gauges, name)) return;
    this.gauges.set(name, value);
  }

  /** One public command call; `outcome` is `ok` or a typed error code. */
  recordCommand(command: string, outcome: string, ms: number): void {
    this.increment(`commands|command=${segment(command)}|outcome=${segment(outcome)}`);
    this.observe(`command_ms|command=${segment(command)}`, ms);
  }

  /** Captures offered to create/replace/result-capture, accepted or rejected by reason. */
  recordCapture(kind: "create" | "replace" | "result", outcome: string): void {
    this.increment(`captures|kind=${kind}|outcome=${segment(outcome)}`);
  }

  recordChanges(resetRequired: boolean): void {
    this.increment(`changes|result=${resetRequired ? "reset" : "delta"}`);
  }

  recordGc(
    result: { removedAssets: number; removedFiles: number; removedEvidence: number },
    ms: number,
  ): void {
    this.increment("gc_runs");
    this.increment("gc_removed_assets", result.removedAssets);
    this.increment("gc_removed_files", result.removedFiles);
    this.increment("gc_removed_evidence", result.removedEvidence);
    this.observe("gc_ms", ms);
  }

  recordMigration(
    outcome: "imported" | "cleaned" | "deferred" | "failed" | "conflict",
    count = 1,
  ): void {
    this.increment(`migration_drafts|outcome=${outcome}`, count);
  }

  recordMigrationItems(count: number): void {
    this.increment("migration_items_imported", count);
  }

  /** Storage commit latency/size and request lifecycle facts derived from it. */
  observeCommit(observation: WebAnnotationCommitObservation): void {
    this.increment(`storage_commits|scope=${observation.scope}`);
    this.observe(`storage_commit_ms|scope=${observation.scope}`, observation.durationMs);
    this.gauge(`storage_index_bytes|scope=${observation.scope}`, observation.indexBytes);
    if (observation.records > 0) {
      this.increment(`storage_records_written|scope=${observation.scope}`, observation.records);
    }
    for (const requestId of observation.requestIds) {
      const before = observation.previous.requests[requestId];
      const after = observation.next.requests[requestId];
      if (!after) continue;
      this.observeRequest(before, after);
    }
  }

  private observeRequest(
    before: WebAnnotationRequest | undefined,
    after: WebAnnotationRequest,
  ): void {
    const operation = segment(after.operation);
    if (!before) {
      this.increment(`requests_created|operation=${operation}`);
      return;
    }
    if (before.state !== after.state) {
      this.increment(
        `request_transitions|from=${segment(before.state)}|to=${segment(after.state)}`,
      );
    }
    if (before.blockedReason !== after.blockedReason && after.blockedReason) {
      this.increment(`queue_holds|reason=${segment(after.blockedReason)}`);
    }
    if (!before.queueReceiptAt && after.queueReceiptAt) {
      const ms = sinceMs(after.enqueueIntentAt, after.queueReceiptAt);
      if (ms !== null) this.observe(`request_enqueue_ms|operation=${operation}`, ms);
    }
    if (!before.dispatchConfirmedAt && after.dispatchConfirmedAt) {
      const ms = sinceMs(after.enqueueIntentAt, after.dispatchConfirmedAt);
      if (ms !== null) this.observe(`request_dispatch_ms|operation=${operation}`, ms);
    }
    if (!before.settledAt && after.settledAt) {
      const ms = sinceMs(after.createdAt, after.settledAt);
      if (ms !== null) {
        this.observe(
          `request_duration_ms|operation=${operation}|state=${segment(after.state)}`,
          ms,
        );
      }
    }
    if (before.state !== "unconfirmed" && after.state === "unconfirmed") {
      this.increment("requests_unconfirmed");
    }
  }

  snapshot(): WebAnnotationMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries(
        Array.from(this.durations, ([key, value]) => [
          key,
          { ...value, buckets: [...value.buckets] },
        ]),
      ),
      gauges: Object.fromEntries(this.gauges),
      droppedSeries: this.droppedSeries,
    };
  }
}
