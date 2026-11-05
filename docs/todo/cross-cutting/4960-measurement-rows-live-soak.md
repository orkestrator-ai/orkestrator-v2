# Prove the measurement row cap on a busy live profile

From [efficiency report](../../reports/2026-10-29-logging-and-database-efficiency.md#r14-bound-measurement-file-rows-d1-highest-value) R14, part 0700 of batch E2, task 4 ("Prove the size curve flattens"). The batch file was deleted when E2 was built; it is in Git history at base commit `e198fd4a7`.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the E2 change applied.

### Tasks

1. **Soak the row cap on a busy live profile**: confirm the database stays near the new bound under real work. Status: open.
2. **Check a restore of tens of thousands of files**: does the preflight finish inside its deadline. Status: open (depends on 1).

### 1. Soak the row cap on a busy live profile

**Problem.** The expected shrink, about 870 MB to under 100 MB, is the report's estimate from one machine sampled on 2026-10-28. The cap has been measured only on a generated workload.

**Context.** The report asks for a soak under the busy live profile in [0048](../transcripts-and-observation/0048-recurring-work-qualification.md), whose tasks 1 and 10 own the driver. The rule that a coordinator or worker never runs against the real data directory stands, so this needs that throwaway driver.

**Investigation.** The generated `measurement-rows` workload (`bun scripts/benchmark-change-tracking.ts --only=measurement-rows`, results in [change tracking](../../architecture/change-tracking.md#benchmarks)) shows file rows bounded at 12,000 for one environment, whatever the bulk size, against 751,834 and 2,082,180 before the change. One real agent turn on a `dev:test` profile stored 2,000 rows of 2,100 changed files, marked partial with 100 omitted. Neither is a busy history with many owners, and rows an existing database already holds go only as they are superseded.

**Decisions.**

- **What decides that the soak passed?**
  - **Row count and file size per owner against the bound, over a run long enough for the hourly pass (recommended).**
    - Pros: the bound is two measurements per owner and scope times 2,000 rows, so a miss points at a specific owner; no dependency on one machine's history.
    - Cons: needs `dbstat` or a row query during the run, which [0810](../../reports/efficiency-logging-database/0750-e15-health-and-diagnostics.md) has not built yet.
  - **The report's whole-database target of under 100 MB.**
    - Pros: simple, and it is the number the report promised.
    - Cons: other tables and an existing file that only reuses its free pages can hide the result.

### 2. Check a restore of tens of thousands of files

**Problem.** A restore past the cap now plans every file from the manifests, but its destination preflight shares one 10 s deadline and answers `changes.restore.runtime-unavailable` when that runs out.

**Context.** `restore.ts` describes each path one at a time on a host worker (`batchSize` 1). The limit was there before the cap, and the cap does not shrink the plan.

**Investigation.** A real restore preview of 2,100 files took about 1.8 s on 2026-11-04, with no file skipped. Nothing larger was run, so the point where it hits 10 s is unknown.

**Decisions.**

- **What to do if a large restore hits the deadline?**
  - **Scale the deadline with the plan size (recommended).**
    - Pros: a bulk mistake is exactly when a user wants restore; the preflight only reads.
    - Cons: a very large preview takes correspondingly long before the dialog can answer.
  - **Leave it and rely on the honest refusal.**
    - Pros: no change; the user is told restore is unavailable.
    - Cons: the largest mistakes stay the ones that cannot be undone.

## Needs verification

- All sizes in the report come from one installation's snapshot of 2026-10-28.
- The extra write transactions of the deferred drain were not measured with real fsyncs. The workload runs with `durable: false`, and [5180](5180-sqlite-durability-tiers.md) (from E5 part `0920`) owns measuring that cost.

## Related

- [4961](4961-measurement-directory-rows.md) and [4962](4962-provisional-capture-spacing.md) wait on this soak.
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md)
- [Change tracking](../../architecture/change-tracking.md#retention-and-backup)
