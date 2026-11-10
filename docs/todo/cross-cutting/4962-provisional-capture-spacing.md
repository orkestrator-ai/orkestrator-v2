# Decide the provisional capture spacing from a measurement

From efficiency report (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`) R15, part 0710 of batch E2, task 3 ("Decide the provisional spacing") and that part's "Needs verification". The batch file was deleted when E2 was built; it is in Git history at base commit `e198fd4a7`.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the E2 change applied. Task 1's dependency re-checked 2026-11-10 against `main` at `c98b20e6f`: the 4960 soak it waited on is done.

### Tasks

1. **Measure capture churn on a live run**: how many provisional captures happen, and how many find an unchanged tree. Status: open (the 4960 soak is done, 2026-11-10, and gave a first count, under Investigation; a run whose agent writes files over time is still needed).
2. **Decide the spacing**: E2 left it unchanged, as the report recommended, until that measurement. Status: open (depends on 1).

### 1. Measure capture churn on a live run

**Problem.** How often a dirty hint produces an unchanged tree was never measured, so it is not known how much the no-change skip saves on real work.

**Context.** `TurnBoundaryService.provisional` now skips the publish when a capture's tree, consistency and inventory-truncation coverage match the latest durably published provisional turn and thread endpoints (an endpoint-less result with no start remains unchanged), but the capture and its snapshot row still happen.

**Investigation.** On the generated `measurement-rows` workload the 6 passes with no tree change wrote 12 fewer measurements (38 to 26 at 20,000 files). That says what a skipped pass saves, not how often one happens in real use. No counter records skipped passes today.

The 4960 busy soak on 2026-11-10 ([Change tracking: busy live soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)) took the recommended temporary count, from the ledger once a minute. In its first hour, before the hourly retention pass, 130 provisional captures were published and 0 to 3 snapshots at any sample were named by no measurement, so at most 3 provisional captures found an unchanged tree. After the pass the count is not usable: pruning freed the snapshots of 117 measurements. The workload is not a typical one for this question: the driver writes each bulk directory in one burst while the turn is held at the fake model, so a turn has one dirty moment rather than a stream of writes. A run whose agent writes files through its own tools over time (the fake model can ask for a `bash` call, `[tool:<id>]` in `recurring-live-ab-fake-model.ts`) would answer it.

**Decisions.**

- **How to count them?**
  - **A temporary count during the soak, from the capture attempts and the snapshots no measurement names (recommended).**
    - Pros: no new product code; both are already in the ledger.
    - Cons: a one-off answer, not ongoing evidence.
  - **A permanent counter in `changes_get_diagnostics`.**
    - Pros: visible on any machine afterwards.
    - Cons: new surface before the number is known to matter.

### 2. Decide the spacing

**Problem.** The report asks to reduce capture frequency while a turn is idle. The spacing is `provisionalSpacingLocalMs` 1,000 and `provisionalSpacingRemoteMs` 5,000 (`policy-registry.ts`).

**Context.** Captures are dirty-driven, so an idle turn with no file activity does not capture on a timer. The cost the report estimates comes from turns writing files. Its "600 to 1,000 commits a minute" is its own estimate and was not counted.

**Investigation.** Not measured. With the row cap and the skip in place, each publish writes at most 2,000 rows per owner, which changes what a capture costs.

**Decisions.**

- **Change the spacing?**
  - **Leave it unless the measurement in task 1 says otherwise (recommended).**
    - Pros: spacing trades diff freshness for writes; the churn it would hide may already be gone.
    - Cons: a session writing files constantly keeps its current rate.
  - **Back off while file activity continues, for example towards 5 s.**
    - Pros: fewer captures in a build or install burst.
    - Cons: the live diff lags during exactly the activity a user watches.

## Assumptions and decisions

### Task 1: Define an unchanged publication

The churn measurement must use durable turn and thread publications, not the segment live pointer, which advances before publication succeeds. Compare inventory truncation as well as tree and consistency; a missing start produces an endpoint-less result and does not prevent checking the other resource.

## Related

- 4960 (retired 2026-11-10): the soak, now in [Change tracking: busy live soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)
- [Change tracking](../../architecture/change-tracking.md#turn-and-thread-boundaries)
