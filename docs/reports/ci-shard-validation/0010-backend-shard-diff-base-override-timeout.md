# Backend CI shard fails when the diff-base override test hits its deadline

## Task analysis

Analysed 2026-11-04 against `main` at `a44641cb`.

### Tasks

1. **Find where the test stalls**: done (the third `readFileList`, waiting on a `git` child whose output never closed).
2. **Fix the stall**: done (bounded in `shell.ts`; confirmation on CI is under Needs verification).

### 1. Find where the test stalls

**Problem.** `saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base` turned the `Tests (backend)` shard red by reaching its 30 s deadline, and the shard turned the `Unit and integration tests` gate red with it. The log gave only the deadline message.

**Context.** The report asked for fresh three-shard results from clean GitHub runners. Those exist (see Current state). The test is flake case [1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md), which attributed it, as a hypothesis, to contention on a shared host.

**Investigation.** Of the 40 most recent `ci.yml` runs on `main` up to `a2bba9d80`, the test failed in four: `a2bba9d80`, `b7f41b692`, `1de19cfc9` and `387d1412f`. In all four, `preview-runaway.test.ts` is the output group before it. Looping the test beside a continuous `preview-runaway.test.ts`, both pinned to four cores, reproduced the miss.

The test now writes a report at 28 s naming the step it is waiting on, with elapsed times and load. All four misses captured that way were in the third `readFileList`, right after `diffStats.sync`, at about 28 s; every other step took milliseconds, and load was 4 to 5. Further probes showed the read joined to a scan of the previous target lineage, with no child process alive, and a `git` child that had exited 0 with no `end` or `close` on its stdout. The details are in case 1537.

**Decisions.** The options and the choice are under Assumptions and decisions.

### 2. Fix the stall

**Problem.** `executeCommandBytes` settles on `close`, so a child that exits without one holds the scan, its pool lease and any joined reader until the command's own deadline (60 s for `git status`).

**Context.** A flake is fixed by removing its cause, never by loosening the test. The test's deadline and assertions are unchanged.

**Investigation.** The owning test ran 435 times under the same load with the fix, with 0 failures, against 5 in 203 before it. 22 of those took over 3 s (maximum 5,969 ms), so the condition still occurs and now costs the grace instead of the deadline. What makes the output go missing is still unknown; [0020](0020-git-output-lost-after-exit.md) owns that.

**Decisions.** The options and the choice are under Assumptions and decisions.

## Current state

The report's outstanding evidence has been observed:

- **The PR run was red.** [Run 41565454422](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41565454422) tested PR #1636 at `142f846d`. `Tests (backend)`, `Tests (workspace)`, `Tests (root-bridges)` and the gate all failed, and the PR merged as `49ee7a15` regardless. The failures logged were outside the files that PR's test addition touched: TS2769 in `container-project-seed-files.ts` failed the workspace build, and the failing tests included `bounded test diagnostics` and `a busy source is refused before the fork extension`.
- **Later `main` runs were green.** All three shards and the gate passed on `a2827f52` ([41722456157](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41722456157)), `74d0bbe1` ([41726802606](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41726802606)) and `a62359f6` ([41727000564](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727000564)).
- **The gate does fail with a single shard.** On `a2bba9d8` ([41727207763](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763)), only `Tests (backend)` failed and the gate failed with it.
- **The three runs after that were red, mostly on something else.** `bounded test diagnostics` failed deterministically on `0bd2cea9`, `a06f16d7` and `a44641cb`, on assertions from #1709 and #1710; this change rewrites them. The other failures there are the registered flakes 0672, 1106 and 2410, each of which passed alone.

## Constraints and rationale

- Do not raise the 30 s deadline, skip the test or loosen its assertions. The repository's flake rules forbid hiding a flake that way.
- The bound must never resolve a command. The `rev-parse` sample had lost its output, and an empty result would read as a clean worktree.

## Needs verification

- A CI pass after the fix. One green run proves little for a failure seen in about one run in ten, so this needs a run of `main` history.
- That CI's misses have the same cause as the local ones. They match in test and deadline only; a further miss on CI prints its step through the report the test keeps.

## Related

- [CI shard validation report, Not done / needs live evidence](../2026-11-03-ci-shard-validation.md#not-done--needs-live-evidence)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [0020 git command output lost after exit](0020-git-output-lost-after-exit.md), the follow-up on the trigger and on reads joining retired scans.
- [0030 test suite and CI health](../../todo/cross-cutting/0030-test-suite-and-ci-health.md), task 1. The required-check ruleset was still unapplied on 2026-11-03 (`gh api repos/orkestrator-ai/orkestrator-v2/rulesets` returned an empty list), which is why #1636 could merge with a red gate. That stays with 0030 as a maintainer action.
- [2922 full and isolated suite failures on main](../../todo/cross-cutting/2922-full-and-isolated-suite-failures-on-main.md), which owns the `bounded test diagnostics` failure.

## Assumptions and decisions

### Task 1: report the unfinished step from a timer inside the test

- **Record each step and report before the deadline (chosen).** This was the file's recommendation. It keeps a permanent, bounded diagnostic (labels and timings only) that also works on CI, and Bun leaves a stalled body suspended at a deadline, so a `finally` could not report. It adds a wrapper around the test's awaits.
- **Reproduce under load only.** It needs no test change, but it would have shown that the test stalls and not where. Load was still used, because it made the diagnostic pay off at once rather than on the next CI miss.

### Task 2: bound the wait after a `git` child exits

- **Fail `git` commands 5 s after exit if output is still open, as a timeout (chosen).** It covers every `git` call, including those in the scan path, and needs no change at call sites. A scan of a retired target is discarded, and a live one retries through the existing failure backoff. The cost is that a `git` command leaving a process holding its output, such as an SSH control master, now fails at 5 s instead of waiting for its deadline.
- **Apply it to every command.** It would also cover `timeoutMs: 0` callers, but the evidence covers only `git`, and a non-git leader may legitimately exit while a descendant keeps writing. Declined until 0020 finds the trigger.
- **Opt in per call.** This has the narrowest effect, but it needs threading through about 20 call sites in `commands-files.ts` alone, and a missed one stays a 60 s stall.
- **Resolve with the output received so far.** Rejected: the `rev-parse` sample shows the output can be lost, and a scan would then report no changes.
