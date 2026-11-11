# Shared metric primitives

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 part `0880` task 3.

### Tasks

1. **Port a metric store to shared primitives when it needs a real change**: one bounded series and one histogram. Status: open (no store needs a change today).

### 1. Port a metric store to shared primitives when it needs a real change

**Problem.** Stores use incompatible histograms, so their snapshots do not compare, and a seventh store would add a seventh shape.

**Context.** The logging report's M4 counts five stores, and two more exist now: `NativeSessionInvalidationMetrics` and the lease waits `LeaseWaitMetrics` added by E15. All are reached through their own commands or the gateway, and all are also in the diagnostics bundle's `metrics.json`.

**Investigation.** `WebAnnotationMetrics` writes cumulative buckets (`web-annotations/metrics.ts`, the loop in `observe`), `RecurringWorkMetrics` and `LeaseWaitMetrics` per-bucket counts, and `PreviewMetrics` sampled values, which since E15 sit in a fixed ring. `GatewayMetricsStore` is in `gateway-support-core.ts`. No reader compares two of them today, and nothing suffers from the difference.

**Decisions.**

- **Is this worth doing now?**
  - **Only when a store needs a real change, porting one at a time (recommended).**
    - Pros: no churn in snapshot-shape tests for its own sake.
    - Cons: inconsistency stays for longer.
  - **Port all at once, as the report proposes.**
    - Pros: one shape and less code.
    - Cons: web-annotation histograms change meaning from cumulative to per-bucket. `/metrics` output is additive, so a changed meaning needs a new field name and every reader has to follow.

## Constraints and rationale

- Metrics stay content-free and bounded.
- `/metrics` output is additive; a changed meaning needs a new field name.

## Related

- [Application logging](../../architecture/logging.md)
