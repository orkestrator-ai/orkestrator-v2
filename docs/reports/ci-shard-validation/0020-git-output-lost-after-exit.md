# Git command output can go missing after the child exits

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Find what makes the output go missing**: open (runtime trigger; repository capture no longer depends on pipe events).
2. **Stop a read waiting on a scan of a retired target**: done for replacement-worktree retargets; same-worktree admission and already parked readers retain their waits.

### 1. Find what makes the output go missing

**Problem.** A `git` child can exit 0 while its stdout never reports data, `end` or `close`. `apps/backend/src/core/shell.ts` now fails such a command 5 s after exit, which bounds the wait but does not remove the cause. A scan of a live target that hits this fails instead of returning a list, so its reader sees an error until the retry (5 s backoff).

**Context.** This was the cause behind flake case [1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md). The bound covers `git` only. Other commands still wait for `close` until their deadline, and one with `timeoutMs: 0` has none.

**Investigation.** Seen on Bun 1.4.4 on `git status` and `git rev-parse` inside the real diff-base test, beside a looping `preview-runaway.test.ts` on four cores. The rate was about 2 to 5% of test runs. Disabling the worktree watcher's `close()` or `stopCapture()` did not change it. About 810,000 spawns in standalone scripts lost nothing, using the same spawn options and the same load, with failing siblings, stream teardown and recursive watcher churn. So the trigger is something else in the real process, and it is not known to be a Bun defect. A check for other holders of the output pipes listed no `pipe:` descriptors, so it says nothing either way. In 435 loaded runs with the fix, no live-target scan failed the test.

**Decisions.**

- **How to find the trigger?**
  - **Bisect the real test by removing work around the failing scan (recommended).** Start from the steps just before it, since the stall always falls at the same point.
    - Pros: it starts from a setup that reproduces within minutes.
    - Cons: each knockout needs a few hundred iterations to mean anything.
  - **Keep growing the standalone script.**
    - Pros: a minimal script is what an upstream Bun report needs.
    - Cons: three versions have not reproduced it, so there is no known direction.

### 2. Stop a read waiting on a scan of a retired target

**Problem.** `readTrackedFileList` (`apps/backend/src/core/diff-stats-service.ts:1326`) awaits `entry.inFlight` even when that attempt belongs to an earlier target generation, whose result `runScan` will discard. Any slow scan of the old target therefore delays a read of the new one.

**Context.** `beginLineage` aborts the attempt, but the signal only cancels a wait for admission. `scanPhysical` passes no signal to its commands, so an admitted scan runs to the end and keeps its pool lease.

**Investigation.** Observed in the stall: `attemptGen` 3 against `targetGeneration` 4, `aborted: true`, one active lease. Not reproduced separately, and no code has changed for it.

**Decisions.**

- **How should a read treat a retired attempt?**
  - **Start the new lineage's scan without waiting, keeping the old lease accounted for (recommended).**
    - Pros: a retarget stops inheriting the old target's latency; the pool still counts work that is physically running.
    - Cons: needs `entry.inFlight` to stop meaning "the only scan", and the per-target admission limit must key on the new target.
  - **Pass the abort signal into the scan's commands.**
    - Pros: also frees the lease sooner.
    - Cons: touches every command in `getLocalGitStatusDetailed`, and a slow fetch of a shared repository may be what another reader is joined to.

## Related

- [0010-backend-shard-diff-base-override-timeout.md](0010-backend-shard-diff-base-override-timeout.md)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)

## Merge reconciliation (2026-11-04)

The investigation above describes the incoming branch before this merge. Its
5 s Git-only mitigation is superseded by file-backed `runCommand` capture and a
macOS lost-exit watchdog. These cover all commands using `runCommand`; other
capture sites and the unresolved Bun trigger are tracked in
[todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md).

Task 2's replacement-worktree case is implemented: `beginLineage` clears the
superseded promise and superseded attempts do not request a rerun. Physical
admission remains keyed by worktree, so a same-worktree retarget still queues,
and an already parked reader still awaits its original promise. Real-pool tests
cover those limits. See [0010](0010-backend-shard-diff-base-override-timeout.md)
and [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
for evidence and CI limitations.
