## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the E2 change applied. Task 2 analysed again and done 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Soak the row cap on a busy live profile**: confirm the database stays near the new bound under real work. Status: open.
2. **Check a restore of tens of thousands of files**: does the preflight finish inside its deadline. Status: done (2026-11-06). It did not: on a busy host 10,000 files reached the 10 s deadline, so the deadline now scales with the plan. Its follow-ups (7310, done and retired 2026-11-10 after quiet- and busy-host live-profile applies of 10,000 and 20,000 files) are in [Change tracking: restore](../../architecture/change-tracking.md#restore) and [7550](7550-restore-apply-throughput.md).

### 1. Soak the row cap on a busy live profile

**Problem.** The expected shrink, about 870 MB to under 100 MB, is the report's estimate from one machine sampled on 2026-10-28. The cap has been measured only on a generated workload.

**Context.** The report asks for a soak under the busy live profile in [0048](../transcripts-and-observation/0048-recurring-work-qualification.md), whose tasks 1 and 10 own the driver. The rule that a coordinator or worker never runs against the real data directory stands, so this needs that throwaway driver.

**Investigation.** The generated `measurement-rows` workload (`bun scripts/benchmark-change-tracking.ts --only=measurement-rows`, results in [change tracking](../../architecture/change-tracking.md#benchmarks)) shows file rows bounded at 12,000 for one environment, whatever the bulk size, against 751,834 and 2,082,180 before the change. One real agent turn on a `dev:test` profile stored 2,000 rows of 2,100 changed files, marked partial with 100 omitted. Neither is a busy history with many owners, and rows an existing database already holds go only as they are superseded.

**Decisions.**

- **What decides that the soak passed?**
  - **Row count and file size per owner against the bound, over a run long enough for the hourly pass (recommended).**
    - Pros: the bound is two measurements per owner and scope times 2,000 rows, so a miss points at a specific owner; no dependency on one machine's history.
    - Cons: needs `dbstat` or a row query during the run. The backup child now samples `dbstat` on each copy ([storage](../../architecture/storage.md#size-waits-and-what-fills-the-file)), at most hourly, by table rather than by owner.
  - **The report's whole-database target of under 100 MB.**
    - Pros: simple, and it is the number the report promised.
    - Cons: other tables and an existing file that only reuses its free pages can hide the result.

### 2. Check a restore of tens of thousands of files

**Problem.** A restore past the cap now plans every file from the manifests, but its destination preflight shared one 10 s deadline and answered `changes.restore.runtime-unavailable` when that ran out.

**Context.** `restore.ts` describes each path one at a time on a host worker (`batchSize` 1), reading and hashing it. The limit was there before the cap, and the cap does not shrink the plan.

**Investigation.** A real restore preview of 2,100 files took about 1.8 s on 2026-11-04, with no file skipped. On 2026-11-06 previews were timed at 2,100 to 90,000 files on an isolated `dev:test` profile (results under [Current state](#restore-preview-measurements-2026-11-06)). The time per file depends heavily on host load: about 0.13 ms on a quieter host and 0.9 to 1.75 ms at a load average of 50 to 63 on 18 cores. At that load 10,000 files reached the 10 s deadline in two previews out of three. From 20,000 to 30,000 files under that load, and at 60,000 written at once on a quieter host, the turn's own end capture ran out of its 30 s deadline first, so the turn had no restorable measurement at all.

**Decisions.**

- **What to do if a large restore hits the deadline?**
  - **Scale the deadline with the plan size (recommended).**
    - Pros: a bulk mistake is exactly when a user wants restore; the preflight only reads.
    - Cons: a very large preview takes correspondingly long before the dialog can answer.
  - **Leave it and rely on the honest refusal.**
    - Pros: no change; the user is told restore is unavailable.
    - Cons: the largest mistakes stay the ones that cannot be undone.

## Current state

Task 1 is open. Task 2 is done: the restore preflight deadline scales with the plan (`restorePreflightDeadlineMs` in `restore.ts`, tested in `restore-preflight.test.ts`).

### Restore preview measurements (2026-11-06)

Method: an isolated `dev:test` profile (`--fixture --no-agent-credentials --agent-platforms claude --headless`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`) with its own Claude config pointed at the loopback model in `e2e/agent-testing/fake-anthropic-model.ts`, so no turn was billed. For each size a new local fixture environment started a Claude session whose prompt the model held. While the turn ran, the driver wrote N small files under `generated/` in the worktree, released the turn, waited for the turn's final (not provisional) measurement, and called `changes_prepare_restore` through the gateway three times, timing each call end to end. Every plan was N deletes. The first runs' host load was not recorded; it is called quieter below because the driver wrote files four to five times faster than in the later runs, whose load averages were read with `uptime`. The throwaway driver lived under the git-ignored `output/agent-testing/` and was deleted afterwards; the profile was stopped and reset.

Previews before the change (fixed 10 s preflight):

| Files | Host | Preview time (3 runs) | Result |
| --- | --- | --- | --- |
| 100 | quieter | 14 ms | preview |
| 2,100 | quieter | 226, 276, 273 ms; again 377, 303, 274 ms | preview |
| 2,100 | load 50 to 56 on 18 cores | 1,852, 1,810, 1,738 ms | preview |
| 10,000 | load 50 to 56 | 10,053, 10,052, 8,947 ms | **`runtime-unavailable` twice**, then preview |

After the change (10 s floor, then per planned path, 5 min ceiling):

| Files | Per-path budget | Host load | Preview time (3 runs) | Result |
| --- | --- | --- | --- | --- |
| 2,100 | 2 ms | about 55 | 1,674, 2,303, 1,463 ms | preview |
| 10,000 | 2 ms | about 55 | 14,985, 6,083, 6,306 ms | preview |
| 20,000 | 2 ms | about 55 | 26,844, 27,152, 34,954 ms | preview |
| 10,000 | 5 ms (shipped) | 57 to 63 | 13,662, 4,366, 6,708 ms | preview |

Where the turn itself could not be restored (the end capture timed out at its 30 s `finalizationDeadlineMs`, the turn went `end-unavailable` and the preview answered `no-retained-endpoints`):

- 60,000 files written at once on the quieter host (30,000 at once published, its end capture taking 11.6 s).
- 30,000, 60,000 and 90,000 files written in 10,000-file chunks 6 s apart, at load 50 to 56.
- 20,000 and 30,000 in chunks at load 57 to 63 (twice for 20,000), although 20,000 had published at load 55.

## Assumptions and decisions

### Task 2: how the restorable turns were produced

Chosen: a real Claude CLI and bridge on the profile, answered by the repository's loopback fake model, with the files written by the driver while the turn was held. The ticket forbids billed turns, and the fake model only answers text, so the files could not come from the agent's own tools. The capture, measurement and restore code paths are the same ones a real turn uses.

### Task 2: whether a realistic size hits the deadline

Chosen: yes, so the deadline was changed. A host running several agents' suites is normal for this application, and at that load 10,000 files, a plausible bulk mistake (a generated or vendored tree), was refused in two previews out of three.

### Task 2: the budget values

Chosen: the old 10 s stays as a floor, the budget is 5 ms per planned path, and the ceiling is 5 minutes (`restorePreflightDeadlineMs`, `restorePreflightPerPathMs` and `restorePreflightMaxDeadlineMs` in `policy-registry.ts`). The first try was 2 ms, which left 20,000 files at 35 s of a 40 s budget. 5 ms is about three times the worst observed rate of 1.75 ms. The ceiling covers 60,000 paths at the budget, and at the observed rates the 100,000-candidate capture limit as well. A preflight that still runs out answers `runtime-unavailable` as before, and never a partly checked plan.

## Needs verification

- All sizes in the report come from one installation's snapshot of 2026-10-28.
- The extra write transactions of the deferred drain were not measured with real fsyncs. The workload runs with `durable: false`, and [5180](5180-sqlite-durability-tiers.md) (from E5 part `0920`) owns measuring that cost.

## Related

- [7550](7550-restore-apply-throughput.md): restore apply throughput at bulk sizes. Its predecessor 7310 (retired 2026-11-10) made turns whose end capture timed out restorable and gave the restore checkpoint a longer deadline.

- [4961](4961-measurement-directory-rows.md) and [4962](4962-provisional-capture-spacing.md) wait on this soak.
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md)
- [Change tracking](../../architecture/change-tracking.md#retention-and-backup)

## Assumptions and decisions

### Task 2: qualification completed under 7310

7310 kept the quiet-host and isolated live-profile evidence open rather than treating busy-host service benchmarks as completion. It was recorded on 2026-11-10 by this file's method (results in [Change tracking: restore](../../architecture/change-tracking.md#restore)), and 7310 was retired. 7550 remains the throughput follow-up.
