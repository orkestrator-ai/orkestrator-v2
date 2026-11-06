# Red lint job merged unguarded: DOM absence offenders and flake number 9834

## Task analysis

Analysed 2026-11-06 against `main` at `c5a478f67`. On 2026-11-05 and
2026-11-06 seven test files with unsafe DOM absence assertions, and two flake
cases reusing number 9834, reached `main`, so the "bun fmt and oxlint" job
failed on every pull request. The branch that added this file fixed both and
closed the local gap that let the scan offenders through. What is left is
gating merges on the job, which is the maintainer's call.

### Tasks

1. **Run the DOM absence scan in the default tier**: move `tests/unit/test-diagnostic-bounds.test.ts` out of the slow tier so `mise run test`, which review preparation runs, includes the scan. Status: done (2026-11-06).
2. **Gate merges on the lint job**: apply the required-check ruleset prepared in [0030](0030-test-suite-and-ci-health.md) task 1, which already lists `bun fmt and oxlint`. Status: open (depends on 0030 task 1; maintainer action).
3. **Catch number collisions between concurrent branches before they reach `main`**: two branches that each pass the flake-index or todo-index check alone can still collide once both merge. Status: open (depends on 2).

### 1. Run the DOM absence scan in the default tier

**Problem.** `bounded test diagnostics > never passes a DOM-producing query
result directly to toBeNull` flagged seven files on `main`:
`EnvironmentNetworkPolicyStatus.test.tsx` (#1878),
`SystemUsageIndicator.test.tsx` (#1865), `DraggableTabBar.launch-override.test.tsx`
(#1880), `MultiReviewFlowGraph.test.tsx` (#1892), `LogDetailSettings.test.tsx`
and `RendererDebugSettings.test.tsx` (#1873), and `info-hint.test.tsx` (#1876).
The PR attribution comes from `git blame` on the flagged lines.

**Context.** The scan and the flaky-test index check were added to the
"bun fmt and oxlint" CI job by #1863 (merged 2026-11-05 22:12 UTC); before
that they ran only in the test shards. The scan file was listed in the slow
tier (`scripts/test-tiers.ts`), which `docs/development/linting.md` stated
and which the repository's validation rules keep out of review preparation.
So no local check that a build pipeline or Multi Review runs ever ran the
scan.

**Investigation.** Read-only `gh` calls on 2026-11-06:

- The scan was not added or tightened after these branches were cut in a way
  that explains them. It existed (in the slow tier) since #1365, and every
  offending PR except #1865 (opened 22:03 UTC) was opened after #1863 put it
  in the lint job; all of them merged after it.
- Every offending PR's own "bun fmt and oxlint" run failed the scan: #1863
  itself (on `SystemUsageIndicator.test.tsx`, from #1862), #1865, #1873,
  #1876, #1878, #1880 and #1892. #1892's run also failed the flaky-test
  index check.
- Five merged within six minutes of being opened (#1873 in 1 min 19 s,
  #1878 in 1 min 35 s, #1876 in 2 min 5 s, #1880 in 2 min 56 s, #1892 in
  5 min 42 s). In every offending PR, including #1865, the lint job itself
  did not start until after the merge: the `CI` run was queued.
- `gh api repos/orkestrator-ai/orkestrator-v2/branches/main/protection`
  answers 404 "Branch not protected", and `gh api .../rulesets` returns an
  empty list. No check is required.
- Once `main` was red, every PR's lint job failed whatever it changed, so a
  new offender looked the same as the inherited ones. #1871 rewrote the two
  files #1862 and #1866 had broken; #1865 broke `SystemUsageIndicator` again
  two minutes later.

The fix removes the file from `SLOW_TESTS`. It spawns only `bun` children of
its own (the two console canaries), as fourteen other default-tier root files
do, and does not wait on Git, tmux, Chromium, servers or wall-clock time,
which is what the tier is for. The whole file ran in 6.2 s locally.

**Decisions.**

- **How should review preparation see the scan?**
  - **Move the file to the default tier (recommended, done).**
    - Pros: one-line change; `mise run test` is already scheduled for every
      code change under `apps/`, `bridges/`, `packages/`, `scripts/` or
      `tests/`; the file matches the tier's definition.
    - Cons: about 6 s more on the root group of the default suite.
  - **Add the scan to `mise run lint`.**
    - Pros: mirrors the CI job, which runs lint and the scan together.
    - Cons: `lint` would start running a test; CI would run the scan twice.
  - **Split the scan into its own default-tier file.**
    - Pros: leaves the canaries in the slow tier.
    - Cons: changes the CI step and its contract test in
      `tests/unit/ci-workflows.test.ts` for a 3 s saving.

### 2. Gate merges on the lint job

**Problem.** The scan in task 1 only helps a branch whose validation runs.
Nothing stops a PR merging while its lint job is red or still running, which
is how all seven offenders landed.

**Context.** [0030](0030-test-suite-and-ci-health.md) task 1 holds the
approved ruleset (`bun fmt and oxlint`, `Typecheck`,
`Unit and integration tests`) and the command to apply it. Applying it is a
repository settings change, which agents must not make.

**Investigation.** As task 1: no protection and no ruleset on 2026-11-06.
`main` must first be green; this branch fixes the two lint-job failures.

**Decisions.**

- **Where is the work tracked?**
  - **In 0030 task 1, linked from here (recommended).**
    - Pros: one place holds the ruleset JSON and the apply command.
    - Cons: the incident that shows why it matters lives here.
  - **A second copy of the ruleset here.**
    - Pros: self-contained.
    - Cons: two copies drift; `tests/unit/ci-workflows.test.ts` parses only
      0030's.

### 3. Catch number collisions between concurrent branches

**Problem.** #1883 (merged 2026-11-06 00:53), #1890 (01:29) and #1892 (01:37)
each added a flake case numbered 9834. Each branch passed
`tests/unit/flaky-tests-index.test.ts` alone; the collision exists only once
two of them merge.

**Context.** The flake register and `docs/todo/` both expect a branch that
merges second to renumber, and reserved ranges (such as 7140 to 7159 for this
branch) avoid the race when the coordinator hands them out. This branch
renumbered the two environment cases to 7140 and 7141 and left the
backend-services case at 9834, because open PR #1889 renames that file to
9835.

**Investigation.** Even with task 2's ruleset, CI runs on the PR's merge ref
when it is pushed, and the prepared ruleset keeps strict up-to-date checks
off. Two PRs that are green against the same `main` can still both merge and
collide.

**Decisions.**

- **How to stop the collision reaching `main`?**
  - **Reserve a number range for every pipeline and prompt environment that may add a flake case or todo (recommended).**
    - Pros: no CI or settings change; already the practice for coordinated work.
    - Cons: relies on whoever writes the brief; a branch without one still takes "the next number".
  - **Turn on strict up-to-date checks or a merge queue.**
    - Pros: every merge is checked against the latest `main`.
    - Cons: 0030 records why strict checks stay off at first (about 226 PRs a
      month and a 21-minute test job); a merge queue needs a `merge_group:`
      trigger in `ci.yml`. A settings change for the maintainer.
  - **Fix forward on `main`, as now.**
    - Pros: no process change.
    - Cons: `main` is red until someone notices, which masks other failures.

## Current state

Task 1 is done: the scan runs in `mise run test`, and the seven files were
rewritten with `scripts/rewrite-bounded-dom-assertions.ts`. The duplicate 9834
cases in `environments-and-containers/` are now 7140 and 7141. Tasks 2 and 3
are open.

## Related

- [0030](0030-test-suite-and-ci-health.md) task 1: the required-check ruleset.
- [linting.md](../../development/linting.md): what the lint job runs.
- Flake cases
  [7140](../../tests/flaky-tests/environments-and-containers/7140-container-status-excludes-aggregate-timeout.md)
  and
  [7141](../../tests/flaky-tests/environments-and-containers/7141-firewall-egress-filter-startup-timeout.md),
  previously both numbered 9834.
