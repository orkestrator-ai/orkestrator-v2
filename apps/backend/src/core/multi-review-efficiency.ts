/**
 * Content-free efficiency measurements for the reviewer fan-out.
 *
 * Multi Review and the build pipeline's multi-reviewer stage share one fan-out
 * runner, so they share one measurement vocabulary. Every label is drawn from
 * a closed enum and every value is a count, a byte total or a duration: a
 * workflow, session or request ID, a path, a prompt, a transcript, a report or
 * an error message can never become a metric label, because the recording API
 * has nowhere to put one.
 *
 * The default observer does nothing. Tests and the benchmark install a
 * recording observer to assert operation counts and to print the baseline.
 * Observation is synchronous and never awaited by orchestration, and every
 * observer call is wrapped so a faulty observer cannot fail a workflow.
 */

export const EFFICIENCY_OWNERS = ["multi-review", "build-pipeline"] as const;
export type EfficiencyOwner = (typeof EFFICIENCY_OWNERS)[number];

export const EFFICIENCY_OPERATIONS = [
  // Reviewer admission and dispatch.
  "reviewer.create",
  "reviewer.prompt",
  "reviewer.send",
  "reviewer.dispatch_skew",
  // Reviewer observation.
  "reviewer.status",
  "reviewer.interactions",
  "reviewer.result",
  "reviewer.task",
  "fence.check",
  // Transcript reads (progress, usage, host mirror, and the UI tab).
  "transcript.probe_due",
  "transcript.probe_throttled",
  "transcript.provider_read_started",
  "transcript.provider_read_failed",
  "transcript.pass_local_reuse",
  "transcript.ui_read",
  "transcript.ui_unchanged",
  "transcript.ui_fallback",
  // Evidence verification.
  "evidence.verify",
  "evidence.permit_reuse",
  // Persistence.
  "workflow.save",
  "workflow.save_safety",
  "workflow.save_observation",
  "workflow.observation_staged",
  "lease.write",
  // Consolidation payload.
  "consolidation.input",
  "consolidation.oversize",
  "report.oversize",
  // Scheduling.
  "scheduler.pass",
  "scheduler.wake",
  // Launch value.
  "launch.duplicate_reviewers",
] as const;
export type EfficiencyOperation = (typeof EFFICIENCY_OPERATIONS)[number];

export const EFFICIENCY_OUTCOMES = [
  "success",
  "retryable",
  "failed",
  "cancelled",
  "ambiguous",
  "fenced",
  "skipped",
] as const;
export type EfficiencyOutcome = (typeof EFFICIENCY_OUTCOMES)[number];

export const EFFICIENCY_PHASES = [
  "preparing",
  "validation",
  "reviewing",
  "consolidating",
  "fixing",
  "ui",
  "other",
] as const;
export type EfficiencyPhase = (typeof EFFICIENCY_PHASES)[number];

/** Provider platforms as a fixed enum; never an account, model or credential. */
export const EFFICIENCY_PLATFORMS = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "pi",
  "other",
] as const;
export type EfficiencyPlatform = (typeof EFFICIENCY_PLATFORMS)[number];

export interface EfficiencyEvent {
  owner: EfficiencyOwner;
  operation: EfficiencyOperation;
  phase?: EfficiencyPhase;
  outcome?: EfficiencyOutcome;
  platform?: EfficiencyPlatform;
  /** Bucketed reviewer count; see {@link reviewerCountBucket}. */
  reviewers?: number;
  /** Numeric measurements only. */
  count?: number;
  bytes?: number;
  elapsedMs?: number;
}

export interface MultiReviewEfficiencyObserver {
  record(event: EfficiencyEvent): void;
}

export const NOOP_EFFICIENCY_OBSERVER: MultiReviewEfficiencyObserver = Object.freeze({
  record() {},
});

const REVIEWER_BUCKETS = [1, 2, 4, 8, 16, 32] as const;

/** Reviewer counts are bucketed so the label space stays finite. */
export function reviewerCountBucket(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 1;
  return REVIEWER_BUCKETS.find((bucket) => count <= bucket) ?? 32;
}

export function efficiencyPlatform(agent: unknown): EfficiencyPlatform {
  return (EFFICIENCY_PLATFORMS as readonly unknown[]).includes(agent)
    ? (agent as EfficiencyPlatform)
    : "other";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Rebuild the event from whitelisted fields so an accidental extra property —
 * a session id spread in from a caller's object — is dropped rather than
 * recorded. Unknown enum values collapse to a fixed fallback.
 */
export function sanitizeEfficiencyEvent(event: EfficiencyEvent): EfficiencyEvent | null {
  if (!(EFFICIENCY_OWNERS as readonly unknown[]).includes(event.owner)) return null;
  if (!(EFFICIENCY_OPERATIONS as readonly unknown[]).includes(event.operation)) return null;
  const phase =
    event.phase === undefined
      ? undefined
      : (EFFICIENCY_PHASES as readonly unknown[]).includes(event.phase)
        ? event.phase
        : "other";
  const outcome =
    event.outcome === undefined
      ? undefined
      : (EFFICIENCY_OUTCOMES as readonly unknown[]).includes(event.outcome)
        ? event.outcome
        : "failed";
  const platform = event.platform === undefined ? undefined : efficiencyPlatform(event.platform);
  const reviewers =
    event.reviewers === undefined ? undefined : reviewerCountBucket(event.reviewers);
  const count = finiteNonNegative(event.count);
  const bytes = finiteNonNegative(event.bytes);
  const elapsedMs = finiteNonNegative(event.elapsedMs);
  return {
    owner: event.owner,
    operation: event.operation,
    ...(phase ? { phase } : {}),
    ...(outcome ? { outcome } : {}),
    ...(platform ? { platform } : {}),
    ...(reviewers === undefined ? {} : { reviewers }),
    ...(count === undefined ? {} : { count }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

/**
 * The only way orchestration code records a measurement. Never throws and
 * never awaits: a broken observer degrades measurement, not the workflow.
 */
export function recordEfficiency(
  observer: MultiReviewEfficiencyObserver | undefined,
  event: EfficiencyEvent,
): void {
  if (!observer || observer === NOOP_EFFICIENCY_OBSERVER) return;
  try {
    const sanitized = sanitizeEfficiencyEvent(event);
    if (sanitized) observer.record(sanitized);
  } catch {
    // Measurement is advisory. Swallowing keeps orchestration independent of it.
  }
}

/** Maximum retained events; the recorder is bounded like every other buffer. */
export const MAX_RECORDED_EFFICIENCY_EVENTS = 100_000;

/** Test/benchmark recorder with bounded retention and simple aggregation. */
export class RecordingEfficiencyObserver implements MultiReviewEfficiencyObserver {
  readonly events: EfficiencyEvent[] = [];
  dropped = 0;

  constructor(private readonly limit = MAX_RECORDED_EFFICIENCY_EVENTS) {}

  record(event: EfficiencyEvent): void {
    if (this.events.length >= this.limit) {
      this.dropped += 1;
      return;
    }
    this.events.push(event);
  }

  /** Number of events for an operation, optionally filtered. */
  count(operation: EfficiencyOperation, filter: Partial<EfficiencyEvent> = {}): number {
    return this.matching(operation, filter).length;
  }

  /** Sum of a numeric field across matching events. */
  sum(
    operation: EfficiencyOperation,
    field: "count" | "bytes" | "elapsedMs",
    filter: Partial<EfficiencyEvent> = {},
  ): number {
    return this.matching(operation, filter).reduce(
      (total, event) => total + (event[field] ?? 0),
      0,
    );
  }

  clear(): void {
    this.events.length = 0;
    this.dropped = 0;
  }

  private matching(operation: EfficiencyOperation, filter: Partial<EfficiencyEvent>) {
    return this.events.filter(
      (event) =>
        event.operation === operation &&
        Object.entries(filter).every(
          ([key, value]) => event[key as keyof EfficiencyEvent] === value,
        ),
    );
  }
}
