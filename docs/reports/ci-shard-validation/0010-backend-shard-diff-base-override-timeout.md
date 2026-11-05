# Backend CI shard fails when the diff-base override test hits its deadline

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`. Acted on 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Find where the test stalls**: make the next deadline miss say which step it was waiting on. Status: done (2026-11-04).
2. **Fix the stall**: remove the cause task 1 identifies, then update flake case 1537. Status: done (2026-11-04). The test no longer depends on the Bun events that get lost, and case 1537 is resolved. CI has not run the fix yet (see Needs verification), and the defect itself is still in Bun ([todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md)).

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

- **Root, in the runtime.** Bun 1.4.4 sometimes loses a completion event of a child that has already exited. On Linux it is the end of a stream: a direct `read` of the stuck socket returned EOF, and `ss` showed the backend as its only holder, so nothing else held the write end. On macOS the exit is lost as well, and the child stays a zombie. `runCommand` settled on the child's `close`, so the child looked unfinished until its own timeout: 10 s or 60 s depending on the command. A 60 s `git status` or `git diff` cannot fit in a 30 s test.
- **Why this test waited, in `DiffStatsService`.** Every stuck child traced at a 10 s timeout on Linux, 18 of 18, belonged to a scan of the previous target. The retarget in the test's `diffStats.sync` step aborted that scan and it could no longer publish, but `entry.inFlight` stayed set, so the new target's first scan and the read at step 24 both waited for it.

Both links are removed:

- `runCommand` captures output through private, already unlinked files and settles on the leader's exit (group waiting is now explicit opt-in), so no stream event is involved (`51ccfb3f2`).
- On macOS, a child with no exit after 1 s is checked with `ps`. A zombie's `xstat` is its true wait status, so the command settles with its real outcome (`4543e8b33`).
- A retarget clears `entry.inFlight`, and a superseded attempt no longer requests a rerun (`1573f4949`).

Stress on the final code, with a probe counting children unsettled after their exit:

| Host | Load | Runs | Misses | Stalled children |
| --- | --- | --- | --- | --- |
| Linux, before | none | 100 | 0 | 20 |
| Linux, after | none | 200 | **0** | **0** |
| Linux, after | 8 CPU hogs | 100 | **0** | **0** |
| macOS, after | 36 CPU hogs | 175 | **0** | **0**; 8 lost exits settled at 1 s |

The miss rate alone would not show this, since the superseded-scan change had already brought it to 0 of 600 while children kept stalling. The stalled count is the measure of the root, and it went from 20 in 100 runs to none. All 122 children the test starts go through `runCommand`.

An earlier attempt failed and is recorded so nobody repeats it: `runCommand` on an eager `Bun.spawn` pipe stalled 121 children in 150 runs, so the defect is not specific to `node:child_process` or its `lazy` reads. The other attempts are in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04): load runs on both hosts, `strace -f`, which hides the race, and about 700,000 standalone children, which never reproduced it. There is still no reduced case, and why Bun loses the event is not established.

**Decisions.**

- **What to change in this repository?**
  - **Capture through unlinked files, with a macOS exit watchdog (recommended).** Implemented.
    - Pros: removes the dependence on the lost events, so a stuck child is gone rather than bounded; loses no output and keeps real exit codes; measured 0 stalled children on both hosts; covers every `runCommand` caller, which also addresses the same-worktree, current-target and parked-reader waits, because they now wait only for real work.
    - Cons: touches the most widely used backend primitive; each command opens two files; the temporary directory has to be usable; a full disk can truncate output (Git reports a failed write as a non-zero exit); the output limit is noticed by polling every 100 ms, so a runaway command can overshoot it on disk until it is killed; `ps` runs synchronously for a command older than 1 s on macOS, at growing intervals up to 16 s.
  - **Fail a command shortly after `exit` when the pipes stay open.**
    - Pros: smallest change to `runCommand`.
    - Cons: the unread output is unreachable through the stream, so a successful command becomes a failure; a read such as this test's would still fail or retry; a fixed grace can fail a slow success on a starved host; does not cover the lost `exit` on macOS.
  - **Rewrite capture on `Bun.spawn` pipes.**
    - Pros: drops the `node:child_process` layer with no change in behaviour.
    - Cons: measured worse, 121 stalled children in 150 runs against 20 in 100. Rejected.
  - **Stop at the superseded-scan change.**
    - Pros: small and local.
    - Cons: removes one wait only. 50 children still stalled in 150 runs, and acceptance review rejected it as not removing the cause. Kept alongside the fix because it is correct on its own, not instead of it.
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
- **Assumption:** the local miss is the same one CI sees. It has the same 30 s signature, but its rate is lower (3.3% in the largest local run, about 10% on `main`), the container is aarch64 and CI is x86-64, and the runner has not yet reported a step. Needs verification below covers this.

### Task 2: case 1537 is resolved on the runCommand fix

- **Chose:** remove the wait in this repository and mark case 1537 resolved. Two earlier rounds on this branch did not: one marked it resolved on the superseded-scan change alone, which review rejected, and one kept it open and left the root to todo 4260, which verification rejected because the cause was shown and not removed.
- **Why:** the ticket requires a shown cause to be removed. The defect stays in Bun, but this code no longer depends on the events it loses, and the stalled-child count went to 0 on both hosts. The earlier reason for leaving `runCommand` alone, that a bound could only turn a stall into a failure, does not apply to file capture, which loses no output.
- **Not claimed:** the defect itself is not fixed, and other `node:child_process` captures in the backend can still hit it. [Todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md) tracks both.

### Task 2: which commands wait for what

- **Chose after review:** settle on leader exit by default, taking a bounded snapshot of stdout/stderr at that point. Output written later by descendants is outside the default capture contract. Callers needing descendant output must set `waitForDescendants: true`; that wait retains the command deadline and group escalation.
- **Why:** preparation exposed three fsmonitor daemon-start timeouts and a subsequent stacked-spy recursion failure. A same-group daemon with redirected output must be allowed to outlive its launching command. The earlier claim that all such helpers detach into their own sessions was incorrect.
- **Alternative:** always wait for the process group, preserving late output automatically. This holds daemon-start calls until timeout and kills their helpers, so it was rejected.
- **Error boundaries:** capture descriptors are registered separately, unlink failure closes its descriptor, and read/stat failures reject while releasing descriptors. `ps` inspections have a 100 ms SIGKILL deadline and 1 MiB output cap; unsuccessful answers stay unknown.
- **Coverage:** redirected same-group helper survival; explicit late-output capture; second-open/unlink/read/stat failure cleanup; slow/failed process inspection and command deadline; project-home status auto-starting an fsmonitor daemon; lifecycle probe through file-backed `runCommand`.
- **Repair validation (2026-11-04, macOS):** shell, process-state, fsmonitor and diff-base integration owners passed together. Deadline/success probe passed 10 repetitions and another 10 with two owned CPU-load workers. Backend typecheck and format/lint checks on edited code passed. These local results do not replace the CI confirmation below.
- **Validation discovery repair:** the preparation command from the root matches no tests because root `bunfig.toml` ignores backend tests. Its exact rerun confirmed that result. Use `mise run test:logged -- --name diff-base-override-integration-corrected -- bun test --cwd apps/backend ./src/core/diff-base-override.integration.test.ts --parallel=1 --only-failures`, which executes the owner successfully.

### Task 2: scope of the retarget guarantee after review

- **Chose:** retain physical admission keyed by worktree and narrow the guarantee to detaching the superseded promise. A same-worktree comparison-ref change still queues behind the old lease, and a reader already awaiting the old promise retains its wait. Real-pool service tests now cover both limits and the path-changing success case. Both waits now last only as long as real work, because a child that has exited no longer looks unfinished.
- **Alternative:** release the lease on abort or key it by comparison ref. That could unblock same-worktree work, but permits overlapping physical scans without proving the old work stopped and weakens the per-worktree resource bound.
- **Why:** the observed miss was a replacement-worktree retarget. The local fix removes that wait while preserving admission bounds. It makes no universal deadline guarantee: a really slow scan can still hold these waits.

## Current state

The report's outstanding evidence has now been observed, so it needs no task:

- **The PR run was red.** [Run 41565454422](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41565454422) tested PR #1636 at `142f846d`. `Tests (backend)`, `Tests (workspace)`, `Tests (root-bridges)` and the gate all failed, and the PR merged as `49ee7a15` regardless. The failures logged were outside the files that PR's test addition touched: TS2769 in `container-project-seed-files.ts` failed the workspace build, and the failing tests included `bounded test diagnostics` and `a busy source is refused before the fork extension`.
- **Later `main` runs were green.** All three shards and the gate passed on `a2827f52` ([41722456157](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41722456157)), `74d0bbe1` ([41726802606](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41726802606)) and `a62359f6` ([41727000564](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727000564)).
- **The gate does fail with a single shard.** On `a2bba9d8` ([41727207763](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763)), only `Tests (backend)` failed and the gate failed with it.

The test now reports its steps on any failure or deadline miss, and a passing run prints nothing extra. Its 30 s deadline, assertions and test tier are unchanged. The cause of the local miss is removed. Whether that ends CI's misses has not been observed yet.

## Constraints and rationale

- Do not raise the 30 s deadline, skip the test or loosen its assertions. The repository's flake rules forbid hiding a flake that way.
- Record the outcome in case 1537 and its group index. It was marked resolved once the cause was removed, with the evidence and a stress run showing no deadline miss.

## Needs verification

- Whether CI's misses are this one. The stall is a wait, not CPU contention, in every local miss, but no CI run has reported a step yet. A CI miss now names its step, so one would settle it, and case 1537 should then be reopened.
- Whether the fix ends the CI misses. One green run proves little for a failure seen in about one run in ten; compare against the four misses in 40 runs recorded above. The local evidence is aarch64 and macOS, and CI is x86-64.

## Related

- [CI shard validation report, Not done / needs live evidence](../2026-11-03-ci-shard-validation.md#not-done--needs-live-evidence)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [Todo 4260](../../todo/cross-cutting/4260-bun-loses-child-process-events.md): the runtime defect behind the stall, still in Bun
- [0030 test suite and CI health](../../todo/cross-cutting/0030-test-suite-and-ci-health.md), task 1. The required-check ruleset is still unapplied (`gh api repos/orkestrator-ai/orkestrator-v2/rulesets` returned an empty list today), which is why #1636 could merge with a red gate. That stays with 0030 as a maintainer action.
- To-do 2922 (finished and removed), which owned the `bounded test diagnostics` failure.

## Merge reconciliation (2026-11-04)

The incoming branch independently bounded lost Git pipe closure at 5 s and
recorded 0 failures in 435 loaded iterations, against 5 in 203 before. That
mitigation is superseded here by file capture and the macOS exit watchdog; its
observations remain useful history, not validation of the merged code. The
incoming timer diagnostic is superseded by the bounded `onTestFinished` helper,
which reports failed steps without leaving a timer after a suspended test.
[0020](0020-git-output-lost-after-exit.md) retains the upstream-trigger work and
the limits of retargeting. Incoming regression coverage for late Git and hook
output uses the explicit `waitForDescendants` contract.

The incoming branch also recorded deterministic `bounded test diagnostics`
failures on `0bd2cea9`, `a06f16d7` and `a44641cb`, and rewrote those assertions.
That work stayed with to-do 2922, since finished and removed.
