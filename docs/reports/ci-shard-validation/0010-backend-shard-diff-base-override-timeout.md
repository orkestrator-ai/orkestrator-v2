# Backend CI shard fails when the diff-base override test hits its deadline

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`. Acted on 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Find where the test stalls**: make the next deadline miss say which step it was waiting on. Status: done (2026-11-04).
2. **Fix the stall**: remove the cause task 1 identifies, then update flake case 1537. Status: done for this test's miss (2026-11-04); the runtime defect behind it is not removed and moves to [todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md). A CI confirmation is still needed (see Needs verification).

### 1. Find where the test stalls

**Problem.** `saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base` turns the `Tests (backend)` shard red by reaching its 30 s deadline, and the shard turns the `Unit and integration tests` gate red with it. It is the only failure in the latest `main` run, so it is what now stands between the clean-runner shards and a stable green.

**Context.** The report asked for fresh three-shard results from clean GitHub runners. Those now exist (see Current state). The test is flake case [1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md), first seen on 2026-10-31 and attributed there, as a hypothesis, to contention on a shared host.

**Investigation.** Of the 40 most recent `ci.yml` runs on `main` (2026-11-03, 12:03 to 22:02 UTC), the test failed in four: `a2bba9d80`, `b7f41b692`, `1de19cfc9` and `387d1412f`. In `a2bba9d80` ([job](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763/job/126235023752)) it was the only failure of 17,041 tests, at 30,000.83 ms. The log gives only the deadline message, so nothing shows which step was waiting.

Running the owning file alone on 2026-11-03 passed both tests in 0.56 s (`bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1`, `2 pass`, `0 fail`). Case 1537 recorded 14.5 s alone on 2026-10-31 on a busy host. A test that needs under a second when idle would have to slow down about fifty times to miss a 30 s deadline, and a fresh CI runner carries only its own shard. That makes a wait worth suspecting as well as CPU contention, but it does not establish one; the two timings come from different hosts and load.

The body (`apps/backend/src/core/diff-base-override.integration.test.ts:16-136`) runs real Git, storage and scans. Its slower steps are `createRepository` and `h.commands` calls, two `readFileList` scans with `refresh: true` (`:44-49`), the `git clone` at `:94`, `diffStats.sync` at `:108`, and `h.cleanup()` at `:134`. The file is not in the slow tier (`scripts/test-tiers.ts` does not name it), and CI runs `test:full` either way, so moving it would not change the shard.

**Decisions.**

- **How to find the stalled step?**
  - **Record each step's elapsed time and print the unfinished step at the deadline (recommended).** A small test-local helper names each await and writes the timings only when the test fails or times out.
    - Pros: the next CI miss identifies the step, with no need to reproduce it; the output is bounded and contains no file contents.
    - Cons: adds diagnostic code to the test; needs another intermittent failure (about one run in ten in this window) before it pays off.
  - **Reproduce locally under CPU and I/O load.**
    - Pros: no test change; faster to iterate if it reproduces.
    - Cons: may not reproduce a 4-core runner's conditions, so a pass would prove little.

### 2. Fix the stall

**Problem.** Finding the step does not stop the shard going red.

**Context.** Depends on what task 1 reports. A flake is fixed by removing its cause, never by loosening the test.

**Investigation.** The miss reproduced locally, with the evidence in [flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#cause-2026-11-04). On unmodified code in a 4-CPU Linux container it missed in 10 of 300 runs, and all 10 reported `waiting on #24 readFileList`. It has two links:

- **Root, in the runtime.** Bun 1.4.4 sometimes loses a completion event of a child that has already exited. `runCommand` settles on the child's `close`, so the child looks unfinished until its own timeout: 10 s or 60 s depending on the command. A 60 s `git status` or `git diff` cannot fit in a 30 s test.
- **Why this test waited, in `DiffStatsService`.** Every stuck child traced at a 10 s timeout on Linux, 18 of 18, belonged to a scan of the previous target. The retarget in the test's `diffStats.sync` step aborted that scan and it could no longer publish, but `entry.inFlight` stayed set, so the new target's first scan and the read at step 24 both waited for it.

The second link is removed: a retarget clears `entry.inFlight` (`beginLineage`), and a superseded attempt no longer requests a rerun when it settles. With that change the test passed 600 of 600 runs on Linux. The first link is not removed: stalled children still occurred, 50 across the last 150 of those runs, and 3 of them were on the current target. The test did not happen to wait on any of them, but a stuck child that it does wait on would still miss the deadline. That is why [todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md) exists and why the CI confirmation matters.

**Decisions.**

- **What to change in this repository?**
  - **Stop a retarget waiting on the scan it superseded (recommended).** Implemented.
    - Pros: removes every observed miss (10 of 300 to 0 of 600); small; correct regardless of the runtime bug, since any slow superseded scan held up the new target; fenced publication already made the scan's result irrelevant.
    - Cons: does not touch the root; a superseded child still holds its admission slot until it settles; a reader already parked on the superseded scan before the retarget still waits for it.
  - **Settle `runCommand` shortly after `exit` when the pipes stay open.**
    - Pros: covers every command in the backend, not just superseded scans.
    - Cons: the unread output is unreachable through the stream, so it can only fail the command; a fixed grace period can fail a slow success on a starved host, across the whole backend; it changes the most widely used primitive on evidence from one test. Left to todo 4260.
  - **Upgrade Bun.**
    - Pros: would address the root if a release fixes it.
    - Cons: `bun upgrade` reports 1.4.4 as the latest release, so there is nothing to upgrade to.

## Assumptions and decisions

### Task 1: where the diagnostics live and when they print

- **Chose:** the recommended helper, `createStepTimings` in `apps/backend/src/core/diff-base-override.integration.test.ts`, reporting from `onTestFinished`.
- **Why:** a probe of Bun 1.4.4 showed that at a test deadline `onTestFinished` runs at once while the test body keeps running, so the hook can see the unfinished step. `test.failing` does not invert a deadline failure in this version, so a forced stall cannot stay green in the suite: the helper's own test uses an injected clock and sink, and the real deadline was checked with a temporary copy (below).
- **Bounds:** at most 64 steps, the oldest dropped first, and 80 characters per name. Names are literals in the test. Arguments, output and error text are never recorded, and a test checks that an error's message is not reported.
- **Forced stall:** a temporary copy whose `git clone` step never settles, at the real 30 s deadline with `--parallel=1 --only-failures`, printed `test did not pass after 30004 ms; waiting on #20 git clone`, every earlier step's time, and `#20 WAITING 29635 ms git clone`, directly above Bun's `(fail)` line. The copy was not committed.

### Task 2: load used, and how the fix was judged

- **Chose:** a miss count on unmodified code against the fixed code, using the same Linux container (`oven/bun:1.4.4`, aarch64, `--cpus=4`, git 2.47.3). Results are in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04).
- **Why:** the report warned that a local pass under load would prove little. The miss appeared without any added load in this container, so before and after counts could be compared directly.
- **Assumption:** the local miss is the same one CI sees. It has the same 30 s signature and a similar rate, but the container is aarch64 and CI is x86-64, and the runner has not yet reported a step. Needs verification below covers this.

### Task 2: marking case 1537 resolved while the root remains

- **Chose:** mark the case resolved, because this test's cause is shown and removed and the stress run is clean, as this file's constraints require. Track the runtime defect separately in [todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md).
- **Why:** the two have different owners and evidence. The case records how to reopen it: a new miss will name its step, and a miss on any step means the root reached this test by another path.

## Current state

The report's outstanding evidence has now been observed, so it needs no task:

- **The PR run was red.** [Run 41565454422](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41565454422) tested PR #1636 at `142f846d`. `Tests (backend)`, `Tests (workspace)`, `Tests (root-bridges)` and the gate all failed, and the PR merged as `49ee7a15` regardless. The failures logged were outside the files that PR's test addition touched: TS2769 in `container-project-seed-files.ts` failed the workspace build, and the failing tests included `bounded test diagnostics` and `a busy source is refused before the fork extension`.
- **Later `main` runs were green.** All three shards and the gate passed on `a2827f52` ([41722456157](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41722456157)), `74d0bbe1` ([41726802606](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41726802606)) and `a62359f6` ([41727000564](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727000564)).
- **The gate does fail with a single shard.** On `a2bba9d8` ([41727207763](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763)), only `Tests (backend)` failed and the gate failed with it.

The test now reports its steps on any failure or deadline miss, and a passing run prints nothing extra. Its 30 s deadline, assertions and test tier are unchanged.

## Constraints and rationale

- Do not raise the 30 s deadline, skip the test or loosen its assertions. The repository's flake rules forbid hiding a flake that way.
- Record the outcome in case 1537 and its group index, and mark it resolved there with the fix and a stress run.

## Needs verification

- Whether CI's misses are this one. The stall is a wait, not CPU contention, in every local miss, but no CI run has reported a step yet. A CI miss now names its step, so one would settle it.
- A run of green CI passes after the fix. One green run proves little for a failure seen in about one run in ten; compare against the four misses in 40 runs recorded above.

## Related

- [CI shard validation report, Not done / needs live evidence](../2026-11-03-ci-shard-validation.md#not-done--needs-live-evidence)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [Todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md): the runtime defect behind the stall
- [0030 test suite and CI health](../../todo/cross-cutting/0030-test-suite-and-ci-health.md), task 1. The required-check ruleset is still unapplied (`gh api repos/orkestrator-ai/orkestrator-v2/rulesets` returned an empty list today), which is why #1636 could merge with a red gate. That stays with 0030 as a maintainer action.
- [2922 full and isolated suite failures on main](../../todo/cross-cutting/2922-full-and-isolated-suite-failures-on-main.md), which owns the `bounded test diagnostics` failure.
