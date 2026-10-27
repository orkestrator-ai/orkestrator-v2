# Nothing stops two todo files or flake cases from taking the same number

Checked against `main` at `863b5782` (2026-10-27).

`docs/README.md` says a todo file's four-digit number is its permanent ID,
unique across all folders. Three files share 0054, created by parallel pull
requests on 2026-10-22, and no test catches it. The flake registry is worse:
29 case numbers are used by more than one file, 0672 by five and 0671 by
seven, and new clashes keep appearing (0826 on 2026-10-25, 0947 and 1011 on
2026-10-26 and 2026-10-27). Prose that cites "0054" or "flake 0672" is
ambiguous. Found in the task analyses of
[0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md#task-analysis)
and
[design-canvas/0054-design-canvas-accessibility-findings.md](../design-canvas/0054-design-canvas-accessibility-findings.md#task-analysis).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Add a guard for todo numbers**: a unit test that fails on a duplicate number under `docs/todo/`, with the existing clash allowlisted. Status: open.
2. **Decide what happens to the three 0054 files**: keep the numbers or renumber the newer two. Status: open.
3. **Guard flake case numbers**: freeze the existing flake duplicates and refuse new ones. Status: open.
4. **Decide how a race between parallel pull requests is caught**: the guard alone catches it only after the second merge. Status: open.

### 1. Add a guard for todo numbers

**Problem.** The README's uniqueness rule for todo numbers is not checked anywhere.

**Context.** `docs/README.md` ("Todo"): "The four-digit number is the file's permanent ID, unique across all folders … Numbers are never reused, and a file keeps its number if it moves to another folder." The only checks on `docs/todo/` are `tests/unit/mise-tasks.test.ts` (task names) and `tests/unit/ci-workflows.test.ts` (0030's ruleset block).

**Investigation.** Confirmed.
- Three files use 0054: `cross-cutting/0054-agent-test-pi-default-model.md` (added in `7e051d95`, #1146, 2026-10-22 08:34), `design-canvas/0054-design-canvas-accessibility-findings.md` (`9a5c84fa`, #1151, 10:49) and `previews-and-annotations/0054-preview-cross-service-reads.md` (`3b469e88`, #1148, 10:59). No other todo number is duplicated.
- No test reads the todo folders for numbers. `tests/unit/flaky-tests-index.test.ts` covers only `docs/tests/flaky-tests/`.
- A related gap the same test could close: `containers-and-environments/0247-test-temp-dir-leaks-from-full-sweep.md` and `0248-playwright-profile-dir-leaks.md` are on `main` (`7809191f`, #1299, 2026-10-26) but have no row in that folder's `0000-index.md`. The README requires a rated row for every file.
- The "next number after the highest" rule cannot be checked after the fact: 0722 was added on 2026-10-24 and 0247/0248 on 2026-10-26.

**Decisions.**

- **Where does the check live?**
  - **A new `tests/unit/todo-index.test.ts`, shaped like `flaky-tests-index.test.ts` (recommended).** It checks that numbers are unique across folders, with an explicit allowlist for 0054, and that each folder index has a row for every file.
    - Pros: one owner for todo-folder rules; the same pattern contributors already know; the index check also catches 0247/0248.
    - Cons: the index check fails until 0247 and 0248 get rows, so those rows must land in the same change.
  - **Add the todo check to `flaky-tests-index.test.ts`.**
    - Pros: one file for every numbered docs registry.
    - Cons: the file's name and `describe` no longer say what it covers; the two registries have different rules.
- **Duplicates only, or the index check too?**
  - **Both (recommended).**
    - Pros: the two most common slips in parallel branches; both are cheap to check.
    - Cons: a branch that adds a file must also add its index row before CI passes, which the README already requires.
  - **Duplicates only.**
    - Pros: smallest change; nothing else needs fixing first.
    - Cons: leaves unindexed files like 0247/0248 unnoticed.

### 2. Decide what happens to the three 0054 files

**Problem.** The clash exists today, and the README says numbers are permanent, so renumbering is itself a rule change.

**Context.** 0054 (cross-cutting) is the oldest of the three. Its own analysis recommends keeping its number. The design-canvas file's analysis recommends deleting it, since its work is finished and the behaviour is already in `docs/architecture/design-canvas.md`; that would leave two.

**Investigation.** Inbound references by full file name: 9 files for the cross-cutting one, 3 for the design-canvas one, 5 for the previews one. Bare "0054" appears in 24 Markdown files under `docs/`.

**Decisions.**

- **Keep or renumber?**
  - **Keep all numbers and allowlist 0054 in the guard; let the design-canvas file's deletion reduce it to two (recommended).**
    - Pros: follows the README's permanence rule; no link churn; links use full file names, so they are not ambiguous.
    - Cons: bare "0054" in prose stays ambiguous; the allowlist is a standing exception.
  - **Renumber the two newer files to fresh numbers and record the old number in each file's "Replaces" section.**
    - Pros: the uniqueness rule holds with no exception.
    - Cons: breaks the permanence rule the README states; edits about eight inbound files in four folders for no behaviour change.

### 3. Guard flake case numbers

**Problem.** The flake registry has no uniqueness rule or check, and duplicates are still being created.

**Context.** The 0030 Related section records the decision not to renumber flake cases, and that "new entries take numbers assigned per branch". `docs/tests/flaky-tests/0000-index.md` ("Recording a case") says how to name a file but not how to choose its number. Cross-group links use relative file paths, so links are not ambiguous; prose IDs are.

**Investigation.** Confirmed by listing case files: 525 case files, 29 numbers used more than once, 45 extra files. 0672 has five files in four groups (two in `design-canvas-and-artifacts`), 0671 has seven, 0947 has four, 0515 has four. 0030's list of reused IDs is out of date: it does not name 0632, 0671, 0673, 0692, 0826, 0947 or 1011. `flaky-tests-index.test.ts:64-80` matches rows to files by name inside one group, so even two files with the same number in one group pass.

**Decisions.**

- **How strict?**
  - **Freeze the current duplicate set in the test and refuse any new duplicate, across and within groups (recommended).**
    - Pros: stops the drift without renumbering 45 files; keeps 0030's decision.
    - Cons: a 29-entry allowlist; it shrinks only if someone renumbers.
  - **Renumber every duplicate.**
    - Pros: a clean registry.
    - Cons: rewrites prose references across case files, which 0030 already rejected.
  - **Make the ID group-qualified (for example `design-canvas-and-artifacts/0672`) and stop treating the number as unique.**
    - Pros: matches how the registry is already used; no allowlist.
    - Cons: changes every prose citation style; the case files' `- **ID:**` lines and the test all change.

### 4. Decide how a race between parallel pull requests is caught

**Problem.** Two open pull requests can each pick the same next number and each pass CI, because each runs against the `main` it started from. The duplicate then appears only on `main` after the second merge.

**Context.** The prepared ruleset in 0030 keeps strict up-to-date checks off (`strict_required_status_checks_policy: false`). This is exactly how 0054 happened: #1146, #1148 and #1151 merged within two and a half hours.

**Investigation.** `ci.yml` runs on `push` to `main` and on `pull_request`, and the test job runs `mise run test:full`, so a root unit test runs on both.

**Decisions.**

- **What happens when the guard fires on `main`?**
  - **Accept a red `main` run and fix forward by renaming the newer file before anything links to it (recommended).**
    - Pros: rare and cheap to fix; a file is usually not yet referenced minutes after merging, so the rename does not break the permanence rule in practice.
    - Cons: one red `main` run per clash.
  - **Turn on strict up-to-date checks.**
    - Pros: catches the race before merge.
    - Cons: 0030 kept them off on purpose, because rebasing every open pull request before merging is costly at this volume.
  - **Reserve numbers in a shared file that each branch edits.**
    - Pros: the second branch gets a merge conflict instead of a duplicate.
    - Cons: every new todo or flake touches one hot file; it conflicts even when the numbers differ.

## Current state

- Three todo files share 0054 (`cross-cutting/`, `design-canvas/`,
  `previews-and-annotations/`); no other todo number is duplicated.
- `containers-and-environments/0247-*` and `0248-*` are not in that folder's
  index.
- The flake registry has 29 duplicated case numbers across 45 extra files;
  0672 has five files, two in one group.
- No test checks todo numbers or todo folder indexes;
  `tests/unit/flaky-tests-index.test.ts` checks flake indexes per group but
  not number uniqueness.

## Outstanding work

### Code

1. Add `tests/unit/todo-index.test.ts`: numbers unique across
   `docs/todo/*/` except the allowlisted 0054, and every numbered file has a
   row in its folder's `0000-index.md`.
2. Add rated rows for `0247-test-temp-dir-leaks-from-full-sweep.md` and
   `0248-playwright-profile-dir-leaks.md` in the same change.
3. Extend `tests/unit/flaky-tests-index.test.ts` to fail on a case number
   used by more than one file, across and within groups, with the current 29
   numbers as a frozen allowlist.
4. Add a line to `docs/tests/flaky-tests/0000-index.md` ("Recording a case")
   saying a new case takes the next number after the highest in use, and to
   the README's "Maintaining the folders" saying what to do when the guard
   fires after a merge.
5. Update the list of reused flake IDs in 0030's Related section.

### Qualification

- None beyond the tests in Code.

## Constraints and rationale

- Numbers are permanent IDs (`docs/README.md`); a guard must not force
  renumbering existing files.
- An allowlist must be exact, so that a new duplicate of an allowlisted
  number (a fourth 0054) still fails.

## Open questions

- Should the flake registry adopt the todo rule (next number after the
  highest, never reused), or group-qualified IDs?

## Needs verification

- None.

## Related

- [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md): where the todo clash was found.
- [design-canvas/0054-design-canvas-accessibility-findings.md](../design-canvas/0054-design-canvas-accessibility-findings.md): the same finding, and the deletion that would remove one copy.
- [previews-and-annotations/0054-preview-cross-service-reads.md](../previews-and-annotations/0054-preview-cross-service-reads.md): the third 0054.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): the earlier decision not to renumber flake cases, and the ruleset's strict setting.
- [Flake registry](../../tests/flaky-tests/0000-index.md)
- [docs/README.md](../../README.md#todo)

## Replaces

Nothing; new on 2026-10-27, split from the task analyses of
[0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md) and
[design-canvas/0054-design-canvas-accessibility-findings.md](../design-canvas/0054-design-canvas-accessibility-findings.md).
