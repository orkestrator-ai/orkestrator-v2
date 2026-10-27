# Diff-stats reset waits past the baseline-owner deadline

- **ID:** 1110
- **Status:** open; cause unconfirmed, aggregate acceptance still pending
- **Date observed:** 2026-10-27
- **Owning file:** `apps/backend/src/core/diff-stats-tracking.test.ts`
- **Test:** `a successful reset to creation clears the advanced baseline and retargets scans`
- **Original command:** pinned `mise run test` at `7517bac5c`, normal workspace
  backend two-worker pool alongside the root, bridge and protocol groups.
- **Original failure:** `validation-05.stdout.txt`, 9755 ms, expected
  `baselineChecks.size` 0, received 1. Backend: 12,008 passed, 120 skipped,
  27 failed and 19 between-test errors. This is the review's captured evidence;
  it was not rerun to reconstruct that aggregate.
- **Classification:** an outstanding baseline-drain deadline observation.
  `idleBaseline` waits at most five seconds for the baseline-owner map to
  empty before this assertion. Its remaining entry explains the failed
  assertion; why the entry remained is not established. The real-Git fixture
  and host scheduling are plausible contributors, as in sibling
  [0962](0962-diff-stats-in-flight-baseline-aggregate-timeout.md).
  This record does not assert that every failure in the owner is a flake.

## Follow-up evidence

Two complete-owner reruns on this branch, using Bun 1.4.4 on macOS arm64:

`mise run test:logged -- --name review-0247-diff-owner -- bun test --cwd apps/backend ./src/core/diff-stats-tracking.test.ts --parallel=1 --only-failures`

- First run: 18 passed, three failed, two between-test errors, 48.35 s.
  Failures: `runtimes isolate snapshots, revisions, emitters, fetch state and
  reconciliation queues for the same environment` (7432.98 ms),
  `a worker that takes in newer target history is retargeted to where its
  branch now leaves it` (12360.26 ms), and `a cached candidate cannot consume
  the worker commits after its PR merges` (hook deadline, 10879.49 ms).
- Retry with name `review-0247-diff-owner-retry`: 19 passed, two failed, one
  between-test error, 29.95 s. The latter two cases failed at 6838.44 and
  9833.04 ms. Both runs reported Git commands reading fixture paths already
  removed after a test deadline. The reset case passed in both runs.
- Artifacts below the host temporary directory:
  `orkestrator-test-run.m1iXu7/review-0247-diff-owner.log.gz` and
  `orkestrator-test-run.yhp4f2/review-0247-diff-owner-retry.log.gz`.

A name-filtered rerun of the reset case plus the two newly registered move
cases passed all three, 15.7 s, using one worker:

`mise run test:logged -- --name review-0247-three-names -- bun test --cwd apps/backend ./src/core/environment-move.test.ts ./src/core/diff-stats-tracking.test.ts --parallel=1 -t 'reports provider failure and retries migration and source cleanup after restart|a raw-path write admitted first blocks copying until its acknowledged edit is present|a successful reset to creation clears the advanced baseline and retargets scans' --reporter=junit --reporter-outfile=/tmp/review-0247-three.xml`

The reset case took 4248.58 ms. The same filtered command in a disposable
detached checkout of the exact pinned base `863b57821` (name
`review-0247-base-three`, Bun 1.4.4) also passed this case, 2617.12 ms. That
run retained a provider/restart move timeout and SQLite teardown error:
two passed, one failed, one between-test error, 14.4 s; artifact
`orkestrator-test-run.shEnkk/review-0247-base-three.log.gz`. JUnit is
`/tmp/review-0247-base-three.xml`.

The complete owner also ran at the pinned base:

`mise run test:logged -- --name review-0247-base-diff-owner -- bun test --cwd apps/backend ./src/core/diff-stats-tracking.test.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/tmp/review-0247-base-diff.xml`

It retained two sibling failures: `a worker that takes in newer target
history is retargeted to where its branch now leaves it` (10078.32 ms) and
`a in-flight candidate cannot consume the worker commits after its PR merges`
(10952.05 ms, hook deadline), with 19 passed, two failed, one between-test
Git/removed-path error, 47.42 s. The reset case passed again. Artifact:
`orkestrator-test-run.zaPkN4/review-0247-base-diff-owner.log.gz`.
This reproduces the owner's deadline/teardown family before this branch,
but not the exact reset assertion.

Both the test owner and `diff-stats-tracking.ts` are byte-for-byte unchanged
between the pinned base and review head. The owner's SHA-1 is
`b9c1e21702cf8feb7d5d2503c72b572ab2ce43ec` at both revisions. This bounds
the changed scope; it does not prove that the assertion failure occurs on
base, nor replace a green complete-owner run. Keep aggregate acceptance
pending until the owner is qualified or the outstanding failure is explained.
No assertion, timeout, skip or diff-stats implementation was changed.

After the required aggregate finished, one final complete-owner rerun used
name `review-0247-diff-owner-post-suite`, the same command and one worker,
with JUnit `/tmp/review-0247-diff-final.xml`: 20 passed, one failed, one
between-test error, 31.41 s. Only `a worker that takes in newer target history
is retargeted to where its branch now leaves it` timed out (10186.41 ms),
with its Git commit terminated by SIGTERM. Artifact:
`orkestrator-test-run.dwZUzT/review-0247-diff-owner-post-suite.log.gz`.
The reset case passed again, including in the 649-second required aggregate.
The sibling timeout also reproduced on the exact pinned base above. No
further repeat was used to search for a passing full-owner result; the
non-green evidence and unconfirmed reset cause remain explicit.
