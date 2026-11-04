# Diff-base override integration scan timeout

- **ID:** 1537
- **Status:** resolved
- **Resolution date:** 2026-11-04; needs a run of green CI passes to confirm, see [Fix](#fix-and-what-it-does-not-cover)
- **Observed:** 2026-10-31
- **Test:** `saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base`
- **File:** `apps/backend/src/core/diff-base-override.integration.test.ts`

During coordinator recovery validation,
`mise run test:logged -- --name repaired-full-suite -- mise run test:full`
timed out this unchanged integration case at 30,011.70 ms against its 30,000 ms
budget. The all-tier workspace reserved four slots with two isolated workers
per package, root reserved one slot, and bridges two. Browser and Electron
validation also ran on the shared Linux host.

The complete owning file passed alone:
`mise run test:logged -- --name isolated-diff-base-existing -- bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1 --only-failures`
(exit zero, 14.5 s). The logged runner removed passing raw output. Aggregate
evidence is in
`/tmp/orkestrator-test-run.eeYqDS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed after completion). Final aggregate counts are retained with that
run's artifacts.

This is an intermittent deadline miss in a real Git and scan scenario.
Shared-host contention is a hypothesis, not an established root cause. No
assertion, timeout, skip, scan implementation or owning test changed.

## Post-repair full rerun

The exact `mise run test:full` command was rerun after repairing the new PR
storage registry entry. It completed in 913.8 s including 204.5 s queued.
This unchanged owner passed in that aggregate; the backend reported 14,591
passed, 145 skipped and 31 failures confined to browser preview/rendering
owners. The first aggregate had 14,586 passed, 145 skipped and 36 failed,
including the subsequently repaired storage writer guard. Final evidence:
`/tmp/orkestrator-test-run.UVuLi8/` and
`/tmp/orkestrator-test-run.sFiOj2/`. The overall command remains non-green.

## Clean-runner observations (2026-11-03)

The test also misses its deadline on fresh GitHub runners, in the `Tests
(backend)` shard of `ci.yml` (`mise run test:full`, four-core runner). It failed
in four of the 40 most recent runs on `main` (12:03 to 22:02 UTC): `a2bba9d80`,
`b7f41b692`, `1de19cfc9` and `387d1412f`. In
[`a2bba9d80`](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763/job/126235023752)
it was the only failure (17,040 passed, 1 failed), at 30,000.83 ms.

The owning file passed alone at `a2bba9d80` on the Linux worktree host:
`bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1`
(2 pass, 0 fail, 0.56 s).

A shared Orkestrator host is therefore not required for the miss. Why it stalls
is still unknown. The work to find out is in
[`docs/reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md`](../../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md).

## Diagnostics (2026-11-04)

The test now names each await through a helper in its own file. When it fails or
reaches its deadline, it prints every step's time and the step it was waiting
on, directly above Bun's `(fail)` line. A passing run prints nothing extra, and
the report holds only literal step names and times. From a real miss, with the
earlier steps left out here:

```text
[step timings] test did not pass after 30008 ms; waiting on #24 readFileList
  #23 ok 0 ms diffStats.sync
  #24 WAITING 29926 ms readFileList
```

## Cause (2026-11-04)

The stall is a wait, not CPU contention. It has two links.

**Bun 1.4.4 loses a completion event of a child that has already exited.**
`runCommand` settles on the child's `close`, which needs the process exit and
the end of both stdio streams. At a real deadline miss on Linux, the in-flight
child was `git status` with its 60 s budget: exit code 0, exited 2 ms after
spawn, stderr closed, and no stdout end for the remaining 29.8 s. Two more misses
showed the same (exited at 3 ms and 6 ms). Which event goes missing varies, and
the process is never still running:

- Linux: the socket is still open in the backend's fd table, the stream reports
  `flowing`, not ended and not destroyed, and `read()` and `resume()` do not
  recover it. `/proc/self/fdinfo` for the epoll instance lists the socket as
  `tfd: 29 events: 40000000`: `EPOLLONESHOT` with no interest bits left. The
  kernel has delivered the readiness event, and it was never re-armed.
- macOS: the same stall, with `exit` missing as well in two of the three traced cases. `ps`
  showed the child as `Z <defunct>` for the whole 10 s, so nothing had reaped it.

Why Bun drops the event is **not established**. The standalone scripts below
never reproduced it, so there is no reduced case.

**`DiffStatsService` made the new target wait for that child.** All 18 stuck
children traced at a 10 s timeout on Linux were in a scan of the previous target
(`repos/comparison`), while step 24 reads `replacement`. The dump taken at a miss
did not record a path, so the same is inferred for the 60 s children there, and
removing the wait is what ended the misses. The retarget at step 23 aborted the
scan and it could no longer publish, but `entry.inFlight` stayed set. So `track()`
only coalesced into it, and the read at step 24 joined it. Step 24 then waited
for a result that would be thrown away.

## Load and stress runs (2026-11-03 to 2026-11-04)

Linux: a throwaway container, `oven/bun:1.4.4`, aarch64, `--cpus=4`, git 2.47.3.
The owning file ran alone, `--parallel=1`, on a host with other work running.

| Code | Load | Runs | Misses | Stalled children seen |
| --- | --- | --- | --- | --- |
| Unmodified, helper only | none | 80 | 1 | not measured |
| Unmodified, helper only | none | 300 | 10, all `#24 readFileList` | not measured |
| Trace added to `shell.ts` | none | 30 | 4, all `#24` | not counted per row |
| Trace added to `shell.ts` | 8 CPU hogs | 60 | 3, all `#24` | not counted per row |
| Trace added to `shell.ts` | 16 CPU hogs, 4 `dd` fsync | 30 | 0 | not counted per row |
| Trace added to `shell.ts` | none | 30 | 1, `#24` | not counted per row |
| Probe added to `shell.ts` | none | 50 | 2, `#24` | 8 |
| Probe, baseline for the rows below | none | 40 | 0 | 4 |
| Probe, watcher `persistent: true` | none | 40 | 1 | 6 |
| Probe, watcher `recursive: false` | none | 40 | 3 | 7 |
| Trace, worktree watcher disabled | none | 40 | 0 | none in the trace |
| **Fixed**, helper only | none | 300 | **0** | not measured |
| **Fixed**, probe | none | 150 | **0** | not observable: the test ends before the probe fires |
| **Fixed**, probe, process held 1.3 s after the test | none | 150 | **0** | **50**: 47 on the previous target, 3 on `replacement` |

macOS (18 cores, a scratch copy that always prints its timings):

| Code | Load | Runs | Misses | Total ms, median / max | Note |
| --- | --- | --- | --- | --- | --- |
| Unmodified | none | 15 | 0 | 531 / 555 | |
| Unmodified | 36 CPU hogs | 175 | 0 | 1,017 / 11,288 | 4 runs had a 10.2 s `#24 readFileList`: a stuck 10 s `git rev-parse` plus the 100 ms kill grace |
| Unmodified | 72 CPU hogs, 8 `dd` fsync | 12 | 0 | 5,548 / 11,347 | Time spread across steps, up to 5.8 s in `createRepository`: real contention, and no single stuck step |
| **Fixed** | 36 CPU hogs | 175 | **0** | 917 / 1,473 | `#24` at most 290 ms |

Not reproduced, about 700,000 children in total, on Linux and macOS with
`node:child_process` and the same spawn options: plain spawn loops, same-tick
batches, long children overlapping short ones (including real `git clone`),
destroying streams after `close` as `fail()` does, and recursive `fs.watch` with
and without churn. Under `strace -f` on Linux, 81 runs of the real test did not
miss, so tracing hides it. The `persistent` and `recursive` rows above show those
two options are not the trigger. The watcher-off row has too few runs, and too
different a scan pattern, to blame the watcher.

## Fix and what it does not cover

Removed for replacement-worktree retargets: the second link. `beginLineage` clears `entry.inFlight`, and a superseded
attempt no longer requests a rerun when it settles (`diff-stats-service.ts`, with
tests in `apps/backend/tests/diff-stats-service.test.ts`). The 30 s deadline,
assertions and test tier are unchanged.

The guarantee is limited to detaching the old promise. The production admission
pool keeps one physical scan per worktree: a same-path comparison-ref retarget
still queues behind a stalled superseded scan, so its read can still miss the
deadline. A reader already awaiting the old promise also keeps waiting until
it settles, then reads its original identity ad hoc. Service tests using a real
`WorkAdmissionPool` cover both limits and a path-changing retarget. Releasing a
lease on abort without proof that the physical work stopped would break the
pool's resource bound; changing that is outside this replacement-worktree fix.

Stress verification: 0 misses in 600 Linux runs against 10 in 300 before, and at
that rate the chance of no miss in the 300 runs without a probe alone is about
0.004%.

Not removed: the first link, tracked in
[todo 4260](../../../todo/cross-cutting/4260-bun-loses-child-process-events.md).
Stalled children still occur, and a stuck child this test does wait on would
still miss the deadline. None did in those 600 runs.

**Reopen this case** on a new deadline miss of this test. Its report names the
step: `#24 readFileList` means the fix did not hold, and any other step means the
root reached the test by another path. CI has not yet confirmed the fix; local
evidence is on aarch64 and CI is x86-64.
