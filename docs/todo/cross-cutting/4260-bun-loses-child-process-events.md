# Bun loses a child's completion events, stalling pipe captures until their timeout

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Report the defect upstream**: give Bun the evidence and, ideally, a reduced case. Status: open.
2. **Find a reduced case**: reproduce the lost event without this repository's code. Status: open.
3. **Decide on a bound in `runCommand`**: stop a backend command waiting out its whole timeout for a child that has exited. Status: done (2026-11-04), through file capture and a macOS exit watchdog rather than a bound.
4. **Unblock readers parked on a superseded scan**: a read already waiting when a retarget arrives still waits for that scan. Status: open.
5. **Move the backend's other pipe captures off Bun's readers**: `node:child_process` captures outside `runCommand` can still stall. Status: open.
6. **Reap children whose exit Bun lost**: on macOS such a child stays a zombie after its command settles. Status: open.

### 1. Report the defect upstream

**Problem.** The root cause is in the runtime, so only a Bun fix removes it. Nobody has told the Bun project.

**Context.** `bun upgrade` reported 1.4.4 as the latest release on 2026-11-04, and the search made that day found no matching report. That search was one query and is not exhaustive. Filing is outward-facing, so it needs the user's approval.

**Investigation.** The evidence is in [flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#cause-2026-11-04). On Linux, the stuck socket shows `events: 40000000` in `/proc/self/fdinfo` for the epoll instance: `EPOLLONESHOT`, delivered and not re-armed. A direct `read` of that socket returns EOF, and `ss` shows the process as its only holder. On macOS the child stays `Z <defunct>`. `Bun.spawn`'s own pipes stall too, more often than `node:child_process`. No Bun canary build was tried.

**Decisions.**

- **When to file?**
  - **Check a canary build, then file with the fdinfo evidence even without a reduced case (recommended).**
    - Pros: the fdinfo line points directly at the event loop; maintainers may recognise it; does not wait on task 2, which may not succeed.
    - Cons: a report with no reduced case is harder to act on; needs the user's approval.
  - **File only with a reduced case.**
    - Pros: far more actionable.
    - Cons: about 700,000 standalone children have not reproduced it, so this could wait indefinitely.

### 2. Find a reduced case

**Problem.** The trigger is unknown. The lost event happens in the real test and in none of the standalone scripts.

**Context.** With the process held open long enough to see them, `diff-base-override.integration.test.ts` produced 50 stalled children across 150 runs on the old `runCommand`. Reproducing it there now needs a pipe capture, since `runCommand` no longer has one. In the incidents whose full timeline was inspected (three on Linux, two on macOS), the stuck child was spawned just before the test's `git clone` exited.

**Investigation.** Not sufficient by themselves, in standalone scripts: spawn options, same-tick batches, overlapping long children, destroying streams after `close`, and recursive `fs.watch`. The watcher's `persistent` and `recursive` options make no difference. What the real process has that the scripts lack: `bun test`, `bun:sqlite`, a real watched repository receiving writes, and the service's unref'd timers. `strace -f` hides the race, 81 runs with no miss.

**Decisions.**

- **How to reduce it?**
  - **Delete from the real test until the stall stops (recommended).** Measure with a probe 1 s after `exit`, holding the process open, since stalls are far more frequent than misses.
    - Pros: starts from something that reproduces; each step is a cheap 100-run comparison.
    - Cons: slower than a fresh script if the trigger turns out to be simple.
  - **Keep growing a standalone script.**
    - Pros: the result is directly reportable.
    - Cons: it has not reproduced in about 700,000 children, with no signal about what to add next.

### 3. Decide on a bound in `runCommand`

**Problem.** Any backend Git command could hit this. A 60 s command waited its whole 60 s after the child had exited, and that wait reached anything awaiting it, including a user-facing read.

**Context.** `runCommand` settled on `close` (`apps/backend/src/core/shell.ts`). Case 1537's acceptance required the shown cause to be removed, which brought this task forward.

**Investigation.** Output cannot be recovered through a stream: `read()`, `resume()` and pause-then-resume all had no effect. A bound alone could therefore only turn a stall into a failure. Avoiding the pipe avoids that: with output in a file, nothing is lost and no stream event is needed. Stress results are in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04): 0 stalled children in 300 Linux runs and 175 macOS runs, where the Linux baseline had 20 in 100. How often the defect reached users was never measured.

**Decisions.**

- **What should `runCommand` do?**
  - **Capture stdout and stderr through unlinked files, and read a lost macOS exit from the zombie's status (recommended).** Implemented in `51ccfb3f2` and `4543e8b33`.
    - Pros: removes the stall instead of bounding it; loses no output and keeps the real exit code; needs no grace period that could fail a slow success.
    - Cons: two file opens per command; the temporary directory has to be usable; the output limit is noticed by polling; default capture ends at leader exit; callers needing late descendant output must opt into group waiting (see the report's decisions).
  - **Fail the command once `exit` has fired, the process group is gone and a grace period has passed.**
    - Pros: smaller change.
    - Cons: fails commands that succeeded, and a too-short grace fails a slow success on a starved host (local runs saw 3.6 s for a healthy child under load).
  - **Do nothing until Bun fixes it.**
    - Pros: no risk to the most widely used backend primitive.
    - Cons: the stall stays, with no known date for a fix, and case 1537 stays open.

### 4. Unblock readers parked on a superseded scan

**Problem.** Case 1537's superseded-scan change detaches new work from the old promise, but a same-worktree retarget still queues behind its admission lease. A `readFileList` already awaiting that scan's promise when the retarget arrives keeps waiting for it, then falls back to an ad hoc read. With task 3 done this waits only for real work, so it is a latency issue on a slow scan rather than a stall.

**Context.** `readTrackedFileList` in `apps/backend/src/core/diff-stats-service.ts`. This was not seen in the original stress runs; a deterministic real-pool service test now confirms the wait and the subsequent ad hoc read of the original identity.

**Investigation.** A parked reader holds `attempt.promise` directly, so clearing `entry.inFlight` does not reach it. The scan's `abort` signal only cancels a queued admission, not a running child.

**Decisions.**

- **How to release it?**
  - **Race the reader's wait against the attempt's abort signal (recommended).**
    - Pros: small and local; the loop already handles a changed lineage.
    - Cons: one more code path in the read loop for a case not yet observed.
  - **Pass the abort signal down to the scan's commands.**
    - Pros: also stops the superseded child and frees its admission slot.
    - Cons: plumbs a signal through every local and container status read.

### 5. Move the backend's other pipe captures off Bun's readers

**Problem.** The defect is still in Bun, so anything else that waits on a child's piped output can still stall until its own timeout.

**Context.** `runCommand` is the main path, and all 122 children of case 1537's test use it, but `node:child_process` is still imported by about 30 backend and protocol files. Examples that capture output include `review-worktree-fingerprint.ts`, `process-identity.ts`, `disk-usage.ts` and `path-safety.ts`.

**Investigation.** None has been seen to stall; the only measurements are of `runCommand`. Long-running followers (`spawnCommand`, `spawnParentBoundCommand`) read live output, so file capture does not fit them.

**Decisions.**

- **How to cover them?**
  - **Move one-shot captures to `runCommand` where it fits, leaving live followers alone (recommended).**
    - Pros: one tested capture path; no new primitive.
    - Cons: each site has its own timeout and signal handling to preserve.
  - **Leave them until one is seen to stall.**
    - Pros: no risk to working code.
    - Cons: a stall there looks like a slow command, so it may not be noticed.

### 6. Reap children whose exit Bun lost

**Problem.** On macOS, a child whose exit Bun lost stays a zombie after `runCommand` settles it, because nothing calls `waitpid` for it.

**Context.** This was 8 children in about 21,000 under heavy CPU load (175 runs of 122 children). Zombies hold a process-table entry and no memory to speak of, and they go when the backend exits. Whether Bun ever reaps them later was not measured.

**Investigation.** Node and Bun expose no `waitpid`, and the watchdog reads the status with `ps` instead. `bun:ffi` could call it, but it could race Bun's own reaper for the same PID.

**Decisions.**

- **What to do about them?**
  - **Count them first, and act only if a long-lived backend accumulates enough to matter (recommended).**
    - Pros: no risk until there is evidence of harm.
    - Cons: the count is not recorded anywhere yet.
  - **Call `waitpid` through `bun:ffi`.**
    - Pros: removes the zombie.
    - Cons: races Bun's reaper and adds a native call to the most used primitive.

## Assumptions and decisions

### Tasks 3 and 4: preserve physical admission during the case 1537 repair

Chose to document and test the same-worktree admission wait and the already-parked reader instead of releasing a running scan's lease on abort. A real `WorkAdmissionPool` test verifies that a comparison-ref-only retarget stays queued until the old work settles; a path-changing retarget proceeds. Another verifies that a parked reader waits, then returns an ad hoc result for its original identity. Releasing on abort would allow overlapping work without proof that the process stopped, violating the pool's physical-release contract. Early reader release remains the open work in task 4.

### Task 3: file capture rather than a bound

Chose file capture because a bound could only fail a command that had succeeded, and the ticket for case 1537 required the cause removed rather than turned into a different failure. The macOS watchdog is limited to macOS because the lost exit was only observed there: none of 141 Linux stalls lost it. Tasks 5 and 6 were added for what this leaves.

## Constraints and rationale

- Never raise a test deadline, skip or retry to hide this; see the [flake rules](../../tests/flaky-tests/0000-index.md).
- Never settle a command as successful when its output may be missing.
- Flake case 1537 and task 2 of [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md) were closed by task 3. Reopen the case if the test misses its deadline again.

## Needs verification

- Whether the lost event happens on x86-64 Linux. All Linux evidence is aarch64 in a container; CI's misses suggest it does, but no CI run has reported a step.
- How often it reaches users through the remaining pipe captures (task 5).
- Whether a Bun canary build still has it.

## Related

- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md)
- [0030 test suite and CI health](0030-test-suite-and-ci-health.md)

## Replaces

Nothing; new observation.

## Assumptions and decisions

### Task 3: completion after daemon regression review

Leader exit now ends default capture; explicit `waitForDescendants` retains late
output and deadline-bound group waiting. Always waiting for the group preserved
late output but blocked same-group fsmonitor daemons, so it was rejected. Tests
cover helper survival, automatic daemon startup through project-home status,
capture filesystem failures, and bounded unknown process inspection.
