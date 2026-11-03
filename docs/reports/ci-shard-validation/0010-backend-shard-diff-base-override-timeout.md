# Backend CI shard fails when the diff-base override test hits its deadline

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Find where the test stalls**: make the next deadline miss say which step it was waiting on. Status: open.
2. **Fix the stall**: remove the cause task 1 identifies, then update flake case 1537. Status: open (depends on 1).

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

**Investigation.** Not started: nothing yet identifies the step.

**Decisions.** None until task 1 reports the step.

## Current state

The report's outstanding evidence has now been observed, so it needs no task:

- **The PR run was red.** [Run 41565454422](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41565454422) tested PR #1636 at `142f846d`. `Tests (backend)`, `Tests (workspace)`, `Tests (root-bridges)` and the gate all failed, and the PR merged as `49ee7a15` regardless. The failures logged were outside the files that PR's test addition touched: TS2769 in `container-project-seed-files.ts` failed the workspace build, and the failing tests included `bounded test diagnostics` and `a busy source is refused before the fork extension`.
- **Later `main` runs were green.** All three shards and the gate passed on `a2827f52` ([41722456157](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41722456157)), `74d0bbe1` ([41726802606](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41726802606)) and `a62359f6` ([41727000564](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727000564)).
- **The gate does fail with a single shard.** On `a2bba9d8` ([41727207763](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41727207763)), only `Tests (backend)` failed and the gate failed with it.

## Constraints and rationale

- Do not raise the 30 s deadline, skip the test or loosen its assertions. The repository's flake rules forbid hiding a flake that way.
- Record the outcome in case 1537 and its group index, and mark it resolved there with the fix and a stress run.

## Needs verification

- Whether the stall is a wait or CPU contention. Only the deadline message and the idle timing above have been observed.
- A CI pass after the fix. One green run proves little for a failure seen in about one run in ten.

## Related

- [CI shard validation report, Not done / needs live evidence](../2026-11-03-ci-shard-validation.md#not-done--needs-live-evidence)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- [0030 test suite and CI health](../../todo/cross-cutting/0030-test-suite-and-ci-health.md), task 1. The required-check ruleset is still unapplied (`gh api repos/orkestrator-ai/orkestrator-v2/rulesets` returned an empty list today), which is why #1636 could merge with a red gate. That stays with 0030 as a maintainer action.
- [2922 full and isolated suite failures on main](../../todo/cross-cutting/2922-full-and-isolated-suite-failures-on-main.md), which owns the `bounded test diagnostics` failure.
