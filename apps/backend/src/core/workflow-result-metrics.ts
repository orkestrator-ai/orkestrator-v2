import type { StructuredOutputProvider } from "@orkestrator/protocol/structured-output";
import type {
  WorkflowResultError,
  WorkflowResultKind,
  WorkflowResultTransport,
} from "@orkestrator/protocol/workflow-results";

/**
 * Bounded, content-free operational counters for workflow result delivery.
 *
 * Everything here is a fixed low-cardinality dimension: provider, result kind,
 * transport, schema version, and the closed error-code set. Result payloads,
 * prompts, diagnostics, evidence paths, digests, receipt ids, and result keys
 * are deliberately never recorded, so a snapshot can be read or exported
 * without exposing review content.
 */

const MAX_SERIES = 512;

export type WorkflowResultSubmissionOutcome = "accepted" | "duplicate" | "conflict" | "rejected";

export interface WorkflowResultDurationSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface WorkflowResultMetricsSnapshot {
  counters: Record<string, number>;
  durations: Record<string, WorkflowResultDurationSummary>;
  gauges: Record<string, number>;
  /** Series dropped because the bounded series table was full. */
  droppedSeries: number;
}

function segment(value: string): string {
  // Series names are assembled from fixed vocabularies. This only guards
  // against a future caller passing something unexpected.
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
}

export class WorkflowResultMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, WorkflowResultDurationSummary>();
  private readonly gauges = new Map<string, number>();
  private droppedSeries = 0;

  recordAttempt(input: {
    provider: StructuredOutputProvider;
    kind: WorkflowResultKind;
    transport: WorkflowResultTransport;
    schemaVersion: number;
  }): void {
    this.increment(
      `attempts|provider=${segment(input.provider)}|kind=${segment(input.kind)}|transport=${segment(
        input.transport,
      )}|schema=${input.schemaVersion}`,
    );
  }

  recordSubmission(input: {
    provider: StructuredOutputProvider;
    kind: WorkflowResultKind;
    outcome: WorkflowResultSubmissionOutcome;
    code?: WorkflowResultError["code"];
  }): void {
    this.increment(
      `submissions|provider=${segment(input.provider)}|kind=${segment(input.kind)}|outcome=${segment(
        input.outcome,
      )}${input.code ? `|code=${segment(input.code)}` : ""}`,
    );
  }

  /** One distinct invalid payload, not one repeated delivery of the same one. */
  recordCorrection(input: { provider: StructuredOutputProvider; kind: WorkflowResultKind }): void {
    this.increment(`corrections|provider=${segment(input.provider)}|kind=${segment(input.kind)}`);
  }

  /** A slot closed without the model ever submitting anything. */
  recordMissingSubmission(input: {
    provider: StructuredOutputProvider;
    kind: WorkflowResultKind;
    reason: "cancelled" | "superseded";
  }): void {
    this.increment(
      `missing_submissions|provider=${segment(input.provider)}|kind=${segment(
        input.kind,
      )}|reason=${segment(input.reason)}`,
    );
  }

  /** A reporting-only continuation dispatched after an earlier attempt closed. */
  recordReportingOnlyContinuation(input: {
    provider: StructuredOutputProvider;
    kind: WorkflowResultKind;
  }): void {
    this.increment(
      `reporting_only_continuations|provider=${segment(input.provider)}|kind=${segment(input.kind)}`,
    );
  }

  recordAcceptanceLatency(kind: WorkflowResultKind, ms: number): void {
    this.observe(`first_submission_to_acceptance_ms|kind=${segment(kind)}`, ms);
  }

  recordConsumptionLatency(kind: WorkflowResultKind, ms: number): void {
    this.observe(`acceptance_to_consumption_ms|kind=${segment(kind)}`, ms);
  }

  recordValidationDuration(kind: WorkflowResultKind, ms: number): void {
    this.observe(`validation_ms|kind=${segment(kind)}`, ms);
  }

  recordStorageDuration(operation: "load" | "save", ms: number): void {
    this.observe(`storage_ms|operation=${segment(operation)}`, ms);
  }

  setGauge(
    name: "pending_calls" | "pending_bytes" | "retained_bytes" | "active_slots",
    value: number,
  ): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(name, Math.max(0, Math.round(value)));
  }

  snapshot(): WorkflowResultMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries(
        Array.from(this.durations, ([key, value]) => [key, { ...value }]),
      ),
      gauges: Object.fromEntries(this.gauges),
      droppedSeries: this.droppedSeries,
    };
  }

  reset(): void {
    this.counters.clear();
    this.durations.clear();
    this.gauges.clear();
    this.droppedSeries = 0;
  }

  private increment(key: string): void {
    const existing = this.counters.get(key);
    if (existing === undefined && this.counters.size >= MAX_SERIES) {
      this.droppedSeries += 1;
      return;
    }
    this.counters.set(key, (existing ?? 0) + 1);
  }

  private observe(key: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const rounded = Math.round(ms);
    const existing = this.durations.get(key);
    if (!existing) {
      if (this.durations.size >= MAX_SERIES) {
        this.droppedSeries += 1;
        return;
      }
      this.durations.set(key, { count: 1, totalMs: rounded, maxMs: rounded });
      return;
    }
    existing.count += 1;
    existing.totalMs += rounded;
    if (rounded > existing.maxMs) existing.maxMs = rounded;
  }
}
