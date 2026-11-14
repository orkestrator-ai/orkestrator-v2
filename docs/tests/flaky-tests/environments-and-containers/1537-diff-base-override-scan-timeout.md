# Diff-base override integration scan timeout

- **ID:** 1537
- **Status:** resolved
- **Observed:** 2026-10-31
- **Resolved:** 2026-11-04, locally; confirmed on CI 2026-11-07 (see [CI confirmation](#ci-confirmation-2026-11-07))
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
is still unknown. The work to find out was CI shard report 0010, since deleted
with the rest of `docs/reports/`; read it with
`git show 413bd6219:docs/reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md`.

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
`runCommand` settled on the child's `close`, which needs the process exit and
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

Direct evidence from a stall on Linux (2026-11-04): a `read` of the stuck socket
returned 0, which is EOF, and `ss -xpn` showed the backend as its only holder with
no peer left. So the kernel has reported the end of the stream, and no other
process is holding the write end. Across 141 Linux stalls the exit event always
arrived; the macOS stalls also lose `exit`.

Why Bun drops the event was not established here: the standalone scripts below
never reproduced it. It is not specific to
`node:child_process`, which calls `Bun.spawn` with `lazy: true`: `runCommand`
rewritten on an eager `Bun.spawn` pipe stalled more often, not less.

**Trigger found later (2026-11-14, to-do
[6900](../../../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md)
task 3).** This test's `await expect(...).rejects`: Bun settles it by running
the event loop from inside the current callback, and that nested tick drops
the rest of the outer tick's ready one-shot polls, among them the EOF of a scan
child exiting at the same moment. Replacing that one `expect` in the reduced
test stopped the loss (0 in 100 runs against 42 lost in 37 of 100), and
`scripts/lost-child-event/nested-tick.ts` reproduces it with nothing from this
repository.

**`DiffStatsService` made the new target wait for that child.** All 18 stuck
children traced at a 10 s timeout on Linux were in a scan of the previous target
(`repos/comparison`), while step 24 reads `replacement`. The dump taken at a miss
did not record a path, so the same is inferred for the 60 s children there, and
removing the wait is what ended the misses in the runs below. The retarget at step 23 aborted the
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
| **Partial fix**, helper only | none | 300 | **0** | not measured |
| **Partial fix**, probe | none | 150 | **0** | not observable: the test ends before the probe fires |
| **Partial fix**, probe, process held 1.3 s after the test | none | 150 | **0** | **50**: 47 on the previous target, 3 on `replacement` |

Stalled children compared across capture methods, same container, owning test only,
process held 1.3 s after the test. A child counts as stalled when it is unsettled 1 s
after its exit, or is a zombie with no exit event:

| Capture | Load | Runs | Misses | Stalled children |
| --- | --- | --- | --- | --- |
| `node:child_process` pipes | none | 100 | 0 | 20 |
| `Bun.spawn` eager pipes | none | 150 | 0 | 121 |
| **Files**, first version, non-reaping PID 1 | none | 300 | **0** | **0** |
| **Files**, final `4543e8b33`, reaping init | none | 200 | **0** | **0** |
| **Files**, final `4543e8b33`, reaping init | 8 CPU hogs | 100 | **0** | **0** |

As a positive control, the same probe flagged `sh -c 'sleep 3 & exit 0'`, whose group
really is alive after 1 s, and the command settled at 3 s. This is historical
group-waiting evidence: after review, that behavior requires explicit
`waitForDescendants: true`. Default capture now snapshots at leader exit,
allowing redirected fsmonitor helpers to survive their launching command.

macOS (18 cores, a scratch copy that always prints its timings):

| Code | Load | Runs | Misses | Total ms, median / max | Note |
| --- | --- | --- | --- | --- | --- |
| Unmodified | none | 15 | 0 | 531 / 555 | |
| Unmodified | 36 CPU hogs | 175 | 0 | 1,017 / 11,288 | 4 runs had a 10.2 s `#24 readFileList`: a stuck 10 s `git rev-parse` plus the 100 ms kill grace |
| Unmodified | 72 CPU hogs, 8 `dd` fsync | 12 | 0 | 5,548 / 11,347 | Time spread across steps, up to 5.8 s in `createRepository`: real contention, and no single stuck step |
| **Partial fix** | 36 CPU hogs | 175 | **0** | 917 / 1,473 | `#24` at most 290 ms |

The same hogs on macOS, counting stalled children (the worktree's real test with the probe):

| Capture | Runs | Misses | Result |
| --- | --- | --- | --- |
| Files, no exit watchdog | 175 | 0 | 9 stalled children, all zombies with no exit event |
| **Files and watchdog**, final `4543e8b33` | 175 | **0** | **0** unsettled after 2.5 s; 8 lost exits settled at the watchdog's first check, 1 s |

Re-measured on 2026-11-06 with a probe that cannot mistake a delay for a loss (an unreaped zombie for 5 s, read through `waitid(WNOWAIT)`): 150 runs, 0 lost exits, and 3 exits delivered 22 to 30 ms after the child became a zombie. The watchdog's single `ps` look counted 10 in 150 runs, so the watchdog settlements above may be early reads of exits Bun was about to report. See to-do 4260, task 2, "Outcome (2026-11-06)" (retired 2026-11-10; its record is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`).

Not reproduced, about 700,000 children in total, on Linux and macOS with
`node:child_process` and the same spawn options: plain spawn loops, same-tick
batches, long children overlapping short ones (including real `git clone`),
destroying streams after `close` as `fail()` does, and recursive `fs.watch` with
and without churn. Under `strace -f` on Linux, 81 runs of the real test did not
miss, so tracing hides it. The `persistent` and `recursive` rows above show those
two options are not the trigger. The watcher-off row has too few runs, and too
different a scan pattern, to blame the watcher.

## Fix (2026-11-04)

Resolved by removing the wait from `runCommand`, on commits `1573f4949`, `51ccfb3f2`
and `4543e8b33`. The 30 s deadline, assertions and test tier are unchanged.

- **Lost end of stream.** Output goes to a private file, unlinked before the child
  starts, and `runCommand` reads it synchronously after the process exits. No pipe
  reader is involved, so the lost event has nothing to stall.
- **Lost exit (macOS).** If a child has not reported an exit after 1 s, and then at
  growing intervals, `runCommand` asks `ps` for its state. A zombie's `xstat` is its true
  wait status, so the command settles with its real exit code or signal.
- **A superseded scan.** `beginLineage` clears `entry.inFlight`, and a superseded
  attempt no longer requests a rerun (`diff-stats-service.ts`), so a retarget to a new
  worktree does not join work whose result would be thrown away.

All 122 children the test starts go through `runCommand`, so none still uses a Bun
pipe reader. The two later limits of the superseded-scan change remain as ordinary
behaviour: a same-worktree retarget still queues behind the old scan's admission
lease, and a reader already parked on the old promise still waits for it. Each now
waits only for work that is really running, not for a child that has already exited.

What this does not cover was tracked in todo 4260 (retired 2026-11-10; its record
is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`, and its macOS reaper is in
[backend runtime](../../../architecture/backend-runtime.md#one-shot-commands)): the
defect is still in Bun, other `node:child_process` captures in the backend can still
hit it, and a child whose exit Bun lost stays a zombie.

**Reopen this case** if the test misses its deadline again. The report names the step:
that identifies a wait this fix did not remove. CI has since run the fix in 91
backend jobs without a miss ([CI confirmation](#ci-confirmation-2026-11-07)).

## Independent incoming mitigation (2026-11-04)

The merged main branch independently reproduced five misses in 203 loaded runs,
then recorded none in 435 runs with a 5 s post-exit Git pipe-close bound. Of
those fixed runs, 22 took over 3 s (maximum 5,969 ms), showing the condition still
occurred. Those results describe that earlier mitigation, not the final merged
code. File capture supersedes it here. Its investigation was CI shard report
0020 (`git show 413bd6219:docs/reports/ci-shard-validation/0020-git-output-lost-after-exit.md`);
the remaining runtime-trigger work is in
todo 4260 (retired 2026-11-10; its upstream report is in the
[manual-test checklist](../../../todo/manual-test/7568-manual-test-checklist.md)) and
[todo 6900](../../../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md).

## CI confirmation (2026-11-07)

The fix has now run on CI. Of the 100 most recent `ci.yml` runs on `main`
(created 2026-11-05 23:02 to 2026-11-07 00:01 UTC, commits `3cdfd98d2` to
`124259a30`), 91 completed the `Tests (backend)` job: 19 passed and 72 failed
on other tests. The failed-job logs of all 93 failed runs (`gh run view <id>
--log-failed`) contain neither this test's name nor its file, and no
`waiting on #` step report. Before the fix it missed in 4 of the 40 runs on
2026-11-03. So the CI misses have stopped with the local cause removed, which
supports, without proving, that they had the same cause: no CI miss ever
reported its step.

`main` was red through this window for unrelated reasons (most often
`test suite ownership`, `bounded test diagnostics` and `native-agent activity
reconciliation lifecycle`), which is why most backend jobs failed.
