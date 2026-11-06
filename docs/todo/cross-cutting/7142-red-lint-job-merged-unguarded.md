# Red lint job merged unguarded: DOM absence offenders and flake number 9834

## Task analysis

Analysed 2026-11-06 against `main` at `c5a478f67`. On 2026-11-05 and
2026-11-06 seven test files with unsafe DOM absence assertions, and two flake
cases reusing number 9834, reached `main`, so the "bun fmt and oxlint" job
failed on every pull request. The branch that added this file fixed both and
closed the local gap that let the scan offenders through. A later branch
(2026-11-06) made concurrent number collisions conflict in Git (task 3). What
is left is gating merges on the job, which is the maintainer's call.

### Tasks

1. **Run the DOM absence scan in the default tier**: isolate the source scan in `tests/unit/dom-absence-scan.test.ts` in the default tier so `mise run test`, which review preparation runs, includes the scan. Status: done (2026-11-06).
2. **Gate merges on the lint job**: apply the required-check ruleset prepared in [0030](0030-test-suite-and-ci-health.md) task 1, which already lists `bun fmt and oxlint`. Status: open (depends on 0030 task 1; maintainer action).
3. **Catch number collisions between concurrent branches before they reach `main`**: two branches that each pass the flake-index or todo-index check alone can still collide once both merge. Status: done (2026-11-06, number claims; does not depend on 2).

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

The original fix moved the whole file to the default tier and measured 6.2 s
locally. Review identified open flake case
[0043](../../tests/flaky-tests/aggregate-validation-runs/0043-root-suite-5000-ms-timeout-cluster.md),
which records this scan exceeding 30 s in three aggregates. A focused pass alone
cannot close that history.

**Decisions.**

- **Isolate and reduce the scan (recommended, implemented).** Keep the scan in
  its own default-tier file; restore the diagnostic subprocess canaries to the
  slow tier. Skip dependency/build/metadata directories and use synchronous
  source reads to avoid per-file asynchronous scheduling. Pros: preserves
  default validation and CI coverage while reducing installed-tree work.
  Cons: CI and its contract test need the new scan path; loaded-host qualification
  remains necessary before closing case 0043.
- **Keep the whole diagnostic file in the default tier.** Pros: smaller diff.
  Cons: adds subprocess canaries and the recorded aggregate timeout risk.

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

It recurred on 2026-11-06: #1957, #1958 and #1960 each merged a todo
numbered 7520, and #1960 and #1961 each merged a 7530, in different area
folders, so `tests/unit/todo-index.test.ts` failed on `main`.

**Decisions.**

- **How to stop the collision reaching `main`?**
  - **A claim file per number, `docs/number-claims/{todo,flaky-tests}/NNNN`, required by `tests/unit/number-claims.test.ts` (recommended, implemented).**
    - Pros: two branches that take the same number add the same path with
      different contents, so Git reports an add/add conflict and GitHub will
      not merge the second PR until it is rebased and renumbered. Different
      numbers never conflict. No CI trigger or repository setting changes.
      The test fails a new file without its claim, so the rule does not
      depend on a brief.
    - Cons: one extra one-line file per new number; claims are required only
      from 7500 (todos) and 9800 (flakes) up, so a file that takes an unused
      number lower down is not protected (new numbers come from the top).
  - **Reserve a number range for every pipeline and prompt environment that may add a flake case or todo.**
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
cases in `environments-and-containers/` are now 6603 and 6602 after merging
`main` (which independently renumbered the same cases). Task 3 is done: the
duplicate todos 7520 and 7530 are renumbered and every new number needs a
claim (see below). Task 2 is open.

## Related

- [0030](0030-test-suite-and-ci-health.md) task 1: the required-check ruleset.
- [Number claims](../../number-claims/README.md): how claims work and what to
  do when one conflicts.
- [linting.md](../../development/linting.md): what the lint job runs.
- Flake cases
  [6603](../../tests/flaky-tests/environments-and-containers/6603-container-status-excludes-aggregate-timeout.md)
  and
  [6602](../../tests/flaky-tests/environments-and-containers/6602-firewall-egress-filter-startup-timeout.md),
  previously both numbered 9834.

## Assumptions and decisions

### Task 1: separate source scanning from subprocess diagnostics

Chose a default-tier scan with explicit source-tree exclusions and kept the
canaries in the slow tier. The CI lint guard now targets the new scan file.
Case 0043 remains open pending loaded-host aggregate evidence; its historical
30-second failures are retained. No timeout was increased and no assertion was
removed.

### Task 3: reconcile concurrent case renames during the main merge

Kept main's established case numbers 6603 and 6602 rather than this branch's
7140 and 7141. This preserves incoming links and the later recurrence evidence
without duplicating cases. Updated the current-state summary and related links;
the earlier renumbering account above remains historical.

### Task 3: number claims instead of reserved ranges

Chose a claim file per number over reserved ranges, because a claim makes a
collision a merge conflict that GitHub enforces without a ruleset (0030 task 1
stays maintainer-only), and the test enforces the claim, so no brief has to
hand out a range. Reserved ranges still work: a branch claims its numbers as
it uses them. Checked by hand that two branches adding `7550` with different
contents conflict and that `7550` and `7551` merge cleanly; no automated Git
test was added, because real-Git tests belong to the slow tier.

Claims are required from 7500 (todos) and 9800 (flakes), just below the
highest numbers in use, rather than for every existing file: backfilling about
a thousand files adds no protection, because collisions happen at the top, and
the historical duplicates initially could not have one owner each. The
review fix below removes the flake exceptions.

The renumbering kept each clashing number on the file that merged first
(squash-merge commit time): agent-engines 7520 (#1957, 20:51 UTC) and
transcripts-and-observation 7530 (#1960, 21:28 UTC). The others moved to the
unused numbers right after the old ones, which no branch taking "the next
number" will race for: containers-and-environments 7520 (#1958) to 7521,
transcripts-and-observation 7520 (#1960) to 7522, and
containers-and-environments 7530 (#1961) to 7531. Each records the old number
in a "Replaces" section. Review found the full-register cleanup incomplete;
the follow-up below removes all 29 historical flake collisions.


### Task 3: remove historical flake collisions and clarify moves

Renumbered 45 flake cases sharing 29 IDs to 9851–9895, with a claim per new
number. For each shared ID, the case with the earliest recorded Git addition
keeps it (path order breaks timestamp ties). Updated case ID fields, group
index rows and repository filename references. Removed the frozen-duplicate
allowlist so every flake number must now be unique. This completes the global
cleanup instead of preserving historical exceptions.

Options: (recommended) renumber historical collisions, which gives every case
an unambiguous ID but changes old links; keep frozen exceptions, which preserves
paths but fails the full-register uniqueness requirement. The implemented
option is renumbering; all tracked filename references were updated.

For moves and slug renames, keep the number and update its claim body in the
same change. The guard distinguishes an existing owner (collision) from an
absent owner (possible move or retired number); it cannot infer file identity.
Fixtures cover both a folder move and a slug rename, the corrected claim,
and a claimed flake duplicate. Retired numbers remain unavailable to new cases.
