# Consolidate metric primitives

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Write-only metrics**: expose or delete `ProgressiveReadMetrics` and `ArtifactMetrics`. Status: open.
2. **Small inefficiencies**: `PreviewMetrics.shift()` and the `/metrics` compatibility read. Status: open.
3. **Shared primitives**: one bounded series and one histogram. Status: open.

### 1. Write-only metrics

**Problem.** Two stores do per-event work for data nothing outside tests reads.

**Context.** M3. Artifacts also log the same events through `logArtifactEvent`, so the log line survives and the counters do not.

**Investigation.** `ProgressiveReadMetrics` is written at `native-agent-transcript-projection.ts:1714`, passed around at `:677` and cleared at `:781`; only `native-agent-progressive-metrics.test.ts` and `native-agent-service-progressive.test.ts` read it. `ArtifactMetrics` is incremented across `transcript-artifacts/service-*.ts`, with `snapshot()` at `metrics.ts:75` and no non-test reader in `apps/backend/src`.

**Decisions.**

- **Expose or delete?**
  - **Delete `ArtifactMetrics` counters that duplicate a log event, and put `ProgressiveReadMetrics` behind a diagnostics command (recommended).**
    - Pros: progressive reads have no other record, and tests already rely on the shape; artifact events are already in the log.
    - Cons: a count over a period is lost for artifacts unless logs are saved.
  - **Expose both through one diagnostics command.**
    - Pros: nothing lost; R11's bundle can read them.
    - Cons: keeps per-event work whose value is unproved.

### 2. Small inefficiencies

**Problem.** A shift per sample, and a synchronous database touch on every `/metrics` GET.

**Context.** M5. Both are small and independent of task 3.

**Investigation.** `apps/backend/src/preview-metrics.ts:53` shifts an array per sample once full. `gateway-handlers.ts:352` and `commands-registry-system.ts:80` call `compatibilityPathUsage.snapshot()`, which is `flush()` (`compatibility-path-usage.ts`), merging through the sink, a transaction in `compatibility-path-usage-store.ts:23`.

**Decisions.**

- **The `/metrics` read?**
  - **Answer from `persisted` plus `pending` in memory, and leave persistence to the existing once-a-minute flush (recommended).**
    - Pros: the merge helper for this already exists in `flush`'s failure branch; a GET costs no I/O.
    - Cons: totals from another backend sharing the directory are up to a minute stale.
  - **Keep it.**
    - Pros: always the durable truth; retiring a compatibility path relies on these counts.
    - Cons: a poll of `/metrics` does write work.

The `shift()` fix has no real choice: a fixed ring of the same size.

### 3. Shared primitives

**Problem.** Stores use incompatible histograms, so snapshots do not compare.

**Context.** M4 counts five stores. A sixth exists now: `NativeSessionInvalidationMetrics` (`native-session-invalidation-metrics.ts:31`).

**Investigation.** `WebAnnotationMetrics` writes cumulative buckets (`web-annotation-metrics.ts`, the loop in `observe`), `RecurringWorkMetrics` per-bucket counts (`recurring-work-metrics.ts:143-152`), and `PreviewMetrics` sampled values. `GatewayMetricsStore` is at `gateway-support-core.ts:912`. All are reached through their own commands or the gateway.

**Decisions.**

- **Is this worth doing?**
  - **Only when a store needs a real change, porting one at a time (recommended).**
    - Pros: no churn in snapshot-shape tests for its own sake; nothing today suffers from the difference.
    - Cons: inconsistency stays for longer.
  - **Port all at once, as the report proposes.**
    - Pros: one shape, and less code.
    - Cons: web-annotation histograms change meaning from cumulative to per-bucket, which any existing reader must follow.

## Constraints and rationale

- Metrics stay content-free and bounded.
- `/metrics` output is additive; a changed meaning needs a new field name.

## Related

- [Logging and database report, R13](../2026-10-29-logging-and-database-efficiency.md#r13-consolidate-metric-primitives-m3-m4-m5) and [the metrics findings](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [0780](0780-r11-export-diagnostics.md)
