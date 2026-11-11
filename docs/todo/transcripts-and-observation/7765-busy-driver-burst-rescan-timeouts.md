# Busy driver: the burst rescan row times out for whole stretches of rounds

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`, on beelink2, while doing
[7562](../cross-cutting/7562-busy-soak-event-loop-stall-growth.md) task 1.

### Tasks

1. **Find why `burst-backend` times out in runs of consecutive rounds**: the busy driver waits up to 60 s for the `diff-scan` changed counter to rise by one per environment after a file burst, and in some runs it never does for dozens of rounds in a row, so a run that kept every obligation exits 1. Status: open.

### 1. Find why `burst-backend` times out in runs of consecutive rounds

**Problem.** The busy phase of `scripts/recurring-live-ab.ts` writes a
2,500-file burst into each of 10 environments and then waits, up to
`BACKEND_WAIT_MS` (60 s), until the gateway's `diff-scan` `changed` counter
has risen by at least the number of environments (`burst-backend`, "Burst:
every environment rescanned"). A timeout counts against the run, so the
driver exits 1 even when every obligation was kept. In four runs on
2026-11-11 the timeouts came in stretches: such a round takes about 68 s
(the 60 s wait and about 8 s of work) instead of 10 to 15 s.

| Run (7562) | Build | Rounds without clients | `burst-backend` timeouts (all rounds) | Pattern |
| --- | --- | --- | --- | --- |
| R1, default root | `83731af28` | 50 of 150 | 17 | 68 s rounds in most of rounds 3 to 20, then none |
| Arm, tmpfs root | `88c1cb15b` | 50 of 100 | 12 | Scattered 68 s rounds |
| Arm, btrfs root with copy-on-write off | `88c1cb15b` | 50 of 100 | 0 | None |
| Instrumented, default root | `dc811586a` | 70 of 70 | 66 | Nearly every round from the second on |

**Context.** The counter is the recurring-work metric for `diff-scan`
attempts that found a change (`diff-stats-service.ts`). The run that timed
out most also had the fewest scans: 20.8 `diff-scan` starts a minute over the
busy window of the instrumented run, against 38 to 62 in the others. Every
round's other obligations (held turn, queued prompt, approval, mail, review)
were kept in all four runs; the tmpfs arm also had one client that did not
show a review's last phase. Long stretches of 68 s rounds lower the run's
load, which probably also gave that run fewer event-loop stalls than R1 at
the same round.

**Investigation.** Not attributed. One possible cause, not checked: a burst
into an environment whose scan is coalesced with a pending one, or that lands
while a scan is running, would move the counter by less than one per
environment. Not the 7562 stall instrumentation: R1 and
the tmpfs arm predate it and show the same 68 s rounds. Read only the
driver's wait (`measureBusy` step 1 in `scripts/recurring-live-ab-busy.ts`)
and the per-round durations and recurring rates in the four result files
(`output/benchmarks/q7562*/result.json`, git-ignored, local to the worktree
that ran them). The diff service's coalescing and its watcher path on Linux
were not read.

Later runs for 7562 task 2 on 2026-11-11 (beelink2): 27 timeouts in 40
rounds at `2a502c28b` (load average 6 to 33), then 3 in 60 rounds at
`a88bac986` (load average 25 to 30), which commits lease rows without a sync
and stores public operation records one row each. Fewer main-database syncs
may matter here; two runs do not show it. The last 7562 run was stopped
before it printed its rows, so it has no count.

**Decisions.**

- **How to settle it?**
  - **Log, per round, which environments' scans ran and what each found, then decide whether the driver's +1 per environment is the wrong expectation or a scan is being lost (recommended).**
    - Pros: tells a measurement mismatch (as 7558 was) from a missed rescan, which would be a product bug in change badges.
    - Cons: one more busy run; the stretches do not appear in every run.
  - **Count the row as passed when every environment's change badge reached the burst.**
    - Pros: no run needed; the client rows already check what a user sees.
    - Cons: the no-client rounds have no client view, so a lost backend rescan would go unnoticed exactly where this row is the only check.

## Related

- [7562](../cross-cutting/7562-busy-soak-event-loop-stall-growth.md): the runs that found it.
- [7202](7202-busy-profile-follow-ups.md) and [0048](0048-recurring-work-qualification.md) task 1: the busy profile.
