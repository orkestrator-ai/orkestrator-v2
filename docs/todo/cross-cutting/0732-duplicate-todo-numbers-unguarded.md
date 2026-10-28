# Nothing stops two todo files or flake cases from taking the same number

Checked against `main` at `863b5782` (2026-10-27). Implemented on
2026-10-28 against `main` at `1d1f0a87`; every item is done.

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

1. **Add a guard for todo numbers**: a unit test that fails on a duplicate number under `docs/todo/`, with the existing clash allowlisted. Status: done 2026-10-28 (`tests/unit/todo-index.test.ts`).
2. **Decide what happens to the three 0054 files**: keep the numbers or renumber the newer two. Status: done 2026-10-28 (kept and allowlisted, with 0723).
3. **Guard flake case numbers**: freeze the existing flake duplicates and refuse new ones. Status: done 2026-10-28 (`FROZEN_DUPLICATES`).
4. **Decide how a race between parallel pull requests is caught**: the guard alone catches it only after the second merge. Status: done 2026-10-28 (fix forward, in `docs/README.md`).

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

- `tests/unit/todo-index.test.ts` (new) checks `docs/todo/`:
  - the top-level index links every area folder and holds no numbered file;
  - no number is shared by two files across folders, except the files listed
    in `ALLOWED_DUPLICATES`: 0054 (cross-cutting, design-canvas,
    previews-and-annotations) and 0723 (agent-engines,
    coordinator-and-multi-review). A file not on that list fails, so a fourth
    0054 or a third 0723 fails; an entry may shrink when a listed file is
    finished and deleted;
  - every folder index has exactly one row per numbered file, ranks run
    1..n, criticality is Very high, High, Medium or Low, and Finished is Yes
    or No.
- `containers-and-environments/0000-index.md` has a rated row for 0248
  (Low, rank 16). 0247 already had one on this base (added after the
  analysis), so only 0248 was missing.
- `tests/unit/flaky-tests-index.test.ts` has a new test: the map of case
  numbers used by more than one file, across and within groups, must equal
  `FROZEN_DUPLICATES` exactly (29 numbers, 74 files, so 45 extra files, as
  the analysis counted). Case files are never deleted, so equality is safe
  and also catches a frozen entry going out of date.
- `docs/tests/flaky-tests/0000-index.md` ("Recording a case") says a new
  case takes the next number after the highest in use, or one from a range
  reserved for the branch, never reuses one, and names the test and its
  frozen list.
- `docs/README.md` ("Maintaining the folders") names the todo guard and its
  two allowlisted numbers, and says how to fix forward when the guard first
  fires on `main` after a parallel merge.
- 0030's Related section lists all 29 reused flake IDs and points at the
  guard.
- Both guards were checked by adding a probe file (a fourth 0054 and a second
  0732 under `docs/todo/mcp/`; a second 1011 and a second 1221 under
  `docs/tests/flaky-tests/web-ui/`): each failed with the clash named, and
  passed again once the probe was removed.

## Outstanding work

### Code

- None. All five items are done:
  1. ~~Add `tests/unit/todo-index.test.ts`.~~ Done; 0723 is allowlisted
     alongside 0054 (see the decisions).
  2. ~~Add rated rows for 0247 and 0248.~~ 0248 added; 0247 already had a row.
  3. ~~Freeze the 29 flake duplicates in `flaky-tests-index.test.ts`.~~ Done.
  4. ~~Document the flake numbering rule and the fix-forward procedure.~~ Done.
  5. ~~Update 0030's list of reused flake IDs.~~ Done.

### Qualification

- None beyond the tests in Code.

## Constraints and rationale

- Numbers are permanent IDs (`docs/README.md`); a guard must not force
  renumbering existing files.
- An allowlist must be exact, so that a new duplicate of an allowlisted
  number (a fourth 0054) still fails.

## Open questions

- None. The former question (should the flake registry adopt the todo rule
  or group-qualified IDs?) is answered by Code item 4: it adopts the todo
  rule (next number after the highest in use, never reused). See the
  decisions.

## Needs verification

- None. The fix-forward procedure has not yet been needed on `main`; the
  guard behaviour it relies on is covered by the probe runs above.

## Assumptions and decisions

### 0723 is allowlisted, not renumbered (Code item 1)

- **Options.** (a) Allowlist both 0723 files, as for 0054. (b) Renumber
  `agent-engines/0723-orkestrator-permission-rules.md` to a fresh number
  (0445 from this branch's range). (c) Renumber the newer
  `coordinator-and-multi-review/0723-build-pipeline-resend-without-dispatch-check.md`,
  as the fix-forward rule would.
- **Choice: (a).**
- **Why.** The second 0723 appeared after the analysis: #1348 added the
  agent-engines file at 14:00 on 2026-10-27 and #1349 the
  coordinator-and-multi-review one at 15:22, the same parallel-merge race
  task 4 describes. Both are now well linked: the agent-engines file is the
  older one and is cited as "0723" in bridge code comments,
  `docs/architecture/permission-rules.md`, other todos and the flake case
  `aggregate-validation-runs/1171-orkestrator-permission-rules-0723-validation.md`,
  whose file name cannot change. The newer file is being implemented on a
  sibling branch and is likely to be finished and deleted, which (a)
  tolerates. (c) would collide with that branch.
- **Pros.** No link churn; follows the permanence rule; no conflict with
  the sibling branch; the allowlist shrinks by itself when a listed file is
  deleted.
- **Cons.** A second standing exception; bare "0723" in prose stays
  ambiguous (and flake 0723 also exists), so prose should cite the file name.

### 0054 keeps all three numbers (task 2)

- **Options.** Keep and allowlist, or renumber the newer two.
- **Choice: keep and allowlist** (the analysis's recommendation).
- **Why.** The permanence rule, and links already use full file names.
- **Pros.** No link churn.
- **Cons.** Bare "0054" in prose stays ambiguous.

### The todo allowlist is a subset check; the flake list is an exact match

- **Options.** (a) Exact equality for both. (b) Subset for both. (c)
  Subset for todos, equality for flakes.
- **Choice: (c).**
- **Why.** Finished todo files are deleted (the design-canvas 0054 and the
  coordinator 0723 are both candidates), so exact equality would turn `main`
  red whenever a parallel branch finishes one. Flake case files are never
  moved or deleted, so equality is safe there and keeps the frozen list
  honest.
- **Pros.** Each check fails on a new duplicate and never on a legitimate
  deletion.
- **Cons.** The todo allowlist can keep a stale entry after a deletion; it is
  harmless and can be trimmed at any time.

### The todo test checks index rows, ranks and ratings, not only presence (Code item 1)

- **Options.** Check only that each file has a row, or also that rows link
  existing files, ranks run 1..n and the criticality and Finished cells hold
  valid values.
- **Choice: the stricter check.**
- **Why.** Every folder index already conforms, and these are the slips a
  parallel branch makes when it inserts a row.
- **Pros.** Catches stale rows, rank gaps and typos in the rating.
- **Cons.** A branch that inserts a row must renumber the ranks below it,
  which the README's ranking already implies.

### 0248 is rated Low

- **Options.** Low, or Medium for the tmpfs use.
- **Choice: Low**, ranked after 0247.
- **Why.** Bare profiles total a few megabytes and hold no user data; the
  larger preview scratch cost is shared with 0247 (also Low), and whether
  production produces it is still unverified there.
- **Pros.** Consistent with 0247 and 0023.
- **Cons.** If 0248's Needs verification shows production leaks preview
  scratch on tmpfs, it should be re-rated.

### Flake numbering adopts the todo rule (Code item 4, former open question)

- **Options.** (a) Next number after the highest in use, never reused. (b)
  Group-qualified IDs.
- **Choice: (a)**, with "or one from a range reserved for the branch",
  because coordinated branches are handed number ranges ahead of the highest.
- **Why.** Code item 4 asked for it, and it needs no change to case files,
  IDs or prose citations.
- **Pros.** One rule for both registries; the guard enforces it.
- **Cons.** Two branches can still race to the same next number; the guard
  catches it on `main` and the README's fix-forward applies.

### A race is fixed forward on `main` (task 4)

- **Options.** Fix forward, strict up-to-date checks, or a reservation file.
- **Choice: fix forward** (the analysis's recommendation), written into
  `docs/README.md`.
- **Why.** 0030 keeps strict checks off on purpose; a reservation file
  conflicts on every new todo.
- **Pros.** Cheap and rare.
- **Cons.** One red `main` run per clash. 0723 shows the rename has to happen
  quickly, before the file gathers links.

## Related

- [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md): where the todo clash was found.
- [design-canvas/0054-design-canvas-accessibility-findings.md](../design-canvas/0054-design-canvas-accessibility-findings.md): the same finding, and the deletion that would remove one copy.
- [previews-and-annotations/0054-preview-cross-service-reads.md](../previews-and-annotations/0054-preview-cross-service-reads.md): the third 0054.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): the earlier decision not to renumber flake cases, and the ruleset's strict setting.
- [agent-engines/0723-orkestrator-permission-rules.md](../agent-engines/0723-orkestrator-permission-rules.md) and
  [coordinator-and-multi-review/0723-build-pipeline-resend-without-dispatch-check.md](../coordinator-and-multi-review/0723-build-pipeline-resend-without-dispatch-check.md):
  the second allowlisted todo number.
- [containers-and-environments/0248-playwright-profile-dir-leaks.md](../containers-and-environments/0248-playwright-profile-dir-leaks.md):
  the file that had no index row.
- [Flake registry](../../tests/flaky-tests/0000-index.md)
- [docs/README.md](../../README.md#todo)

## Replaces

Nothing; new on 2026-10-27, split from the task analyses of
[0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md) and
[design-canvas/0054-design-canvas-accessibility-findings.md](../design-canvas/0054-design-canvas-accessibility-findings.md).
