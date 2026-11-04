# Bun loses a child's completion events, stalling `runCommand` until its timeout

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Report the defect upstream**: give Bun the evidence and, ideally, a reduced case. Status: open.
2. **Find a reduced case**: reproduce the lost event without this repository's code. Status: open.
3. **Decide on a bound in `runCommand`**: stop a backend command waiting out its whole timeout for a child that has exited. Status: open (depends on 2).
4. **Unblock readers parked on a superseded scan**: a read already waiting when a retarget arrives still waits for that scan. Status: open.

### 1. Report the defect upstream

**Problem.** The root cause is in the runtime, so only a Bun fix removes it. Nobody has told the Bun project.

**Context.** `bun upgrade` reported 1.4.4 as the latest release on 2026-11-04, and the search made that day found no matching report. That search was one query and is not exhaustive. Filing is outward-facing, so it needs the user's approval.

**Investigation.** The evidence is in [flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#cause-2026-11-04). On Linux, the stuck socket shows `events: 40000000` in `/proc/self/fdinfo` for the epoll instance: `EPOLLONESHOT`, delivered and not re-armed. On macOS the child stays `Z <defunct>`. No Bun canary build was tried.

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

**Context.** With the process held open long enough to see them, `diff-base-override.integration.test.ts` produced 50 stalled children across 150 runs. In the incidents whose full timeline was inspected (three on Linux, two on macOS), the stuck child was spawned just before the test's `git clone` exited.

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

**Problem.** Any backend Git command can hit this. A 60 s command waits its whole 60 s after the child has exited, and that wait reaches anything awaiting it, including a user-facing read. This test no longer waits on superseded scans, but the same stall on a scan or command that is awaited is still possible, in the product as well as in tests.

**Context.** `runCommand` settles on `close` (`apps/backend/src/core/shell.ts`), deliberately, because a descendant can still hold the pipes after the leader exits. How often this reaches users is not measured: the rate above comes from one test.

**Investigation.** Output cannot be recovered through the stream: `read()`, `resume()` and pause-then-resume all had no effect. The bytes are still in the socket, but Bun exposes no supported way to read them. So a bound can only turn a long stall into a prompt failure, and the caller must be able to survive one. Silently succeeding with what was captured would be worse than stalling: a `git status` with no output reads as "no changes".

**Decisions.**

- **What should a bound do?**
  - **Measure first, then fail the command once `exit` has fired, the process group is gone and a grace period has passed (recommended).** Count how often it would fire in the backend before turning it on.
    - Pros: replaces a 60 s stall with a prompt, honest failure; the group check keeps real descendants working; scans already retry a failure.
    - Cons: a too-short grace fails a slow success on a starved host (local runs saw 3.6 s for a healthy child under load); touches every backend command, so it needs its own review.
  - **Capture stdout and stderr through temporary files instead of pipes.**
    - Pros: avoids the lost stream event and loses no output.
    - Cons: disk I/O on every command; rewrites the output limits; the lost `exit` seen on macOS still needs a bound.
  - **Do nothing until Bun fixes it.**
    - Pros: no risk to the most widely used backend primitive.
    - Cons: the stall stays, with no known date for a fix.

### 4. Unblock readers parked on a superseded scan

**Problem.** Case 1537's fix stops new work waiting on a superseded scan. A `readFileList` already awaiting that scan's promise when the retarget arrives keeps waiting for it, then falls back to an ad hoc read.

**Context.** `readTrackedFileList` in `apps/backend/src/core/diff-stats-service.ts`. This was not seen in any run; it follows from the code.

**Investigation.** A parked reader holds `attempt.promise` directly, so clearing `entry.inFlight` does not reach it. The scan's `abort` signal only cancels a queued admission, not a running child.

**Decisions.**

- **How to release it?**
  - **Race the reader's wait against the attempt's abort signal (recommended).**
    - Pros: small and local; the loop already handles a changed lineage.
    - Cons: one more code path in the read loop for a case not yet observed.
  - **Pass the abort signal down to the scan's commands.**
    - Pros: also stops the superseded child and frees its admission slot.
    - Cons: plumbs a signal through every local and container status read.

## Constraints and rationale

- Never raise a test deadline, skip or retry to hide this; see the [flake rules](../../tests/flaky-tests/0000-index.md).
- Never settle a command as successful when its output may be missing.

## Needs verification

- Whether the lost event happens on x86-64 Linux. All Linux evidence is aarch64 in a container; CI's misses suggest it does, but no CI run has reported a step.
- How often it reaches users of the real backend.
- Whether a Bun canary build still has it.

## Related

- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [CI shard report 0010](../../reports/ci-shard-validation/0010-backend-shard-diff-base-override-timeout.md)
- [0030 test suite and CI health](0030-test-suite-and-ci-health.md)

## Replaces

Nothing; new observation.
