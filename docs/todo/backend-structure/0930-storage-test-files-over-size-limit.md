# Storage test files over the size limit, and the writer guard's scan budget

## Task analysis

Analysed 2026-10-29 against `main` at `79f3bc97e`. Statuses rechecked and the work done on 2026-10-30 against `main` at `cd7bbe3e5`.

### Tasks

1. **Split `apps/backend/src/core/storage.test.ts` by topic**: 4,322 lines, 22 top-level `describe` blocks. Status: done (`f034c8a26`).
2. **Split `apps/backend/tests/storage.test.ts` by area**: 3,206 lines at analysis, 2,855 at `cd7bbe3e5`, one `describe` with 74 tests. Status: done (`9570ec160`), with a different cut from the recommended one (see **Assumptions and decisions**).
3. **Split `storage-agent-mail.test.ts` along the agent mail collaborators**: 2,292 lines. Status: done (`dbbe87e3c`).
4. **Split `storage-writer-guards.test.ts` and bring its raw-writer scan within budget**: 2,481 lines; the scan test times out under host load (flake [1309](../../tests/flaky-tests/backend-services-and-tooling/1309-storage-writer-guard-raw-scan-timeout.md)). Status: done (split `cbc76815f`, scan `dda88f007`).
5. **Qualification**: the same test counts before and after, then `mise run test`. Status: done (see **Current state**; the first `mise run test` failed only in two unchanged owners that passed alone, flake case [1316](../../tests/flaky-tests/aggregate-validation-runs/1316-storage-test-split-0930-validation.md)).

### 1. Split `apps/backend/src/core/storage.test.ts` by topic

**Problem.** The file is more than twice the 2,000-line guideline in `AGENTS.md`. Since 0214, its sources live in `storage-shared-<topic>.ts` modules and per-area repositories, but the tests for all of them still sit in one file. Anyone changing one config field or catalogue cache has to read the whole thing.

**Context.** Todo 0214 (decision "Should the over-limit storage test files be handled too?"; retired on 2026-10-29, see [`storage.md`](../../architecture/storage.md#code-layout)) recommended a new todo for the storage test files it left over the limit. This is that todo. `AGENTS.md` asks for tests to be split to match their sources.

**Investigation.** The 22 blocks group by subject. Config normalisation and migrations come first: `defaultConfig` (`:42`), first-run platform selection, the SSH agent socket, Claude mode and favourite-model normalisation, the OpenCode allowlist and the SDK/ACP bridge runtime (`:42`–`:731`). Next comes the large `backend-owned setup and build surfaces` block (`:732`–`:2134`, 1,400 lines). Then pane-layout intents and tab teardown intents (`:2135`–`:2728`), PR metadata and completion intents (`:2729`–`:2916`), and more config migrations (`:2917`–`:3113`). The rest is hot-store read caching (`:3114`), environment completion and unread state (`:3340`), Kanban point reads and session buffer deletion, the OpenCode and host-agent model catalogue caches (`:3560`–`:4260`), and diff baselines (`:4261`). The file has no `mock.module`. The temp-directory helpers at the top are shared by every block.

**Decisions.**

- **How to cut it?**
  - **By source module: `storage-shared-config.test.ts`, `storage-setup-build.test.ts`, `storage-pane-layout.test.ts`, `storage-model-catalogs.test.ts`, and the remainder in `storage.test.ts` (recommended).** Move whole `describe` blocks verbatim, and put the shared temp-directory helpers in a small support module. Use `storage-shared-config.test.ts` for the config blocks because `src/core/storage-config.test.ts` already contains a separate StorageService config migration suite.
    - Pros: each file matches the `storage-shared-<topic>.ts` module or repository it tests; the diff moves code without editing it; every file ends up well under 2,000 lines.
    - Cons: `storage-setup-build.test.ts` is about 1,400 lines on its own; one more support module.
  - **Halve the file mechanically.**
    - Pros: smallest decision.
    - Cons: the halves still have no single subject, so the readability problem stays.

### 2. Split `apps/backend/tests/storage.test.ts` by area

**Problem.** This integration file is 3,206 lines with one top-level `describe("Electron StorageService")`, over the guideline.

**Context.** It exercises the facade against a real database: config round-trips and credentials, project/environment CRUD, review instructions, leases and backups.

**Investigation.** It starts with `mock.module("sharp", …)` (`:34`) for Kanban image resizing, plus lease helpers (`abandonLease`, `heldLeases`, `leaseHeld`) and `withFixedDate`. Bun applies a module mock to the whole file, so any file split off that touches Kanban images needs the same mock. The 82 tests fall into config (credentials, debug-log retention, review instructions, GitHub credential source), records (projects, environments, names), leases and backup recovery, and Kanban.

**Decisions.**

- **How to cut it?**
  - **By area into `tests/storage-config.test.ts`, `tests/storage-records.test.ts` and `tests/storage-leases.test.ts`, with the Kanban tests and the `sharp` mock kept in `tests/storage.test.ts` (recommended).**
    - Pros: only one file carries the module mock; the lease helpers move with the lease tests.
    - Cons: config tests here and in task 1 share a subject across `src/core` and `tests`; the folders already split that way.
  - **Merge them into the task 1 files.**
    - Pros: one file per subject.
    - Cons: mixes the `src/core` unit tests with `tests/` integration fixtures and the module mock, and makes the diff larger.

### 3. Split `storage-agent-mail.test.ts` along the agent mail collaborators

**Problem.** The file is 2,292 lines, 292 over the guideline.

**Context.** Todo 0163 split `AgentMailRepository` into `AgentMailStore`, `AgentMailboxDirectory`, `AgentMailInjects` and `AgentMailBudgets`. The tests did not follow.

**Investigation.** There are two top-level blocks: `StorageService agent mail` (`:98`–`:1611`, about 1,500 lines) and `StorageService agent mail routes` (`:1612` onwards, about 680 lines), 45 tests in all.

**Decisions.**

- **How to cut it?**
  - **Move the routes block to `storage-agent-mail-routes.test.ts` as it is (recommended).**
    - Pros: one verbatim move brings both files under the limit (about 1,600 and 700 lines).
    - Cons: the main file still mixes the directory, inject and budget tests.
  - **One file per collaborator.**
    - Pros: matches the 0163 sources.
    - Cons: the tests drive the facade, not the collaborators, so assigning each one to a file is judgement-heavy for a size-only change.

### 4. Split `storage-writer-guards.test.ts` and bring its raw-writer scan within budget

**Problem.** The file is 2,481 lines. On the shared Linux host, its test `raw StorageDatabase writers outside StorageService > name the store they write` (`:1904`) also exceeds Bun's 5,000 ms default under load, in aggregates and alone, both on branches and on clean `origin/main`.

**Context.** The full diagnosis is in flake [1309](../../tests/flaky-tests/backend-services-and-tooling/1309-storage-writer-guard-raw-scan-timeout.md). `AGENTS.md` ("Flaky Test Tracking") forbids hiding a flake by loosening the test.

**Investigation.** The file has an analysis library (about 1,700 lines of helpers: `analyzeStorageWriters`, `rawDatabaseWrites`, `parse`, `walk`) and three `describe` blocks: `StorageService store writers` (`:1703`), the raw-writer block (`:1899`) and `store writer analysis` (`:2061`, the fixtures that test the analysis itself).

The raw-writer block's first test builds `rawDatabaseWrites(backendSources(), …)` lazily, so that one test pays for the whole cost. It parses all 820 non-test backend sources (12.9 MB) with `oxc-parser`, keeps every tree alive, then walks every tree and every importer of each row helper. At load average about 2 this takes 1.44 s in the full file. In the 111-file storage run with `--parallel=6` it took 3.02 s. Kept trees cost 950 ms to parse, against 203 ms when each is dropped straight away. Separately, `identifiersOutside` (`:1320`) re-reads and re-parses backend files for its own checks.

**Decisions.**

- **How to fix the budget?**
  - **Make the scan cheaper without changing what it proves (recommended).** Parse each backend file once per test file and share the trees between `rawDatabaseWrites` and `identifiersOutside`. Walk for raw writes only in files whose text names a `RAW_WRITERS` method. Parse the other files on demand, when `moduleOf` or `callsOf` needs them. `callsOf` only follows files that import the declaring module, which a text check on the specifier finds.
    - Pros: lowers the cost at its source; the guard's results stay the same, and comparing them before and after proves it; the margin no longer shrinks as the backend grows.
    - Cons: `callsOf` has to find importers without parsing every file, which needs a careful text prefilter; the analysis code changes, so the comparison is mandatory.
  - **Build the scan in a `beforeAll` with an explicit timeout.**
    - Pros: a few lines; every test reports its own result.
    - Cons: this only raises the budget, which is the loosening `AGENTS.md` forbids, and the cost keeps growing.
  - **Move the scan into a separate process or a cached artefact.**
    - Pros: no budget at all.
    - Cons: a cache can go stale and let a violation through; far more machinery than the problem needs.
- **How to split the file?**
  - **Move the analysis library to `storage-writer-guards-analysis.ts` (test-only, not `*.test.ts`), and keep the facade, raw-writer and analysis-fixture blocks in their own test files (recommended).**
    - Pros: each test file has one subject; the fix above lands in the library alone.
    - Cons: the library is a non-test file that only tests import, so it must be kept out of the backend build and out of the scan's own source list. `backendSourceFiles` would then pick it up, so it needs a `RAW_WRITER_EXEMPTIONS`-style exclusion or must live outside `src`.
  - **Split only the fixtures block out.**
    - Pros: smallest move.
    - Cons: the library stays mixed with the facade tests.

### 5. Qualification

**Problem.** Splitting must keep every test, and the scan change must not change what the guard finds.

**Context.** 0163 and 0214 compared the guard's full analysis before and after with an ad hoc dump.

**Investigation.** The test counts today are: `src/core/storage.test.ts` 135, `tests/storage.test.ts` 82, `storage-agent-mail.test.ts` 45, `storage-writer-guards.test.ts` 36.

**Decisions.**

- **What proves the result?**
  - **Same test counts per subject before and after, the ad hoc guard dump compared before and after task 4, the guard test's time in the focused `--parallel=6` storage run, then `mise run test` (recommended).**
    - Pros: covers both risks, a lost test and a changed analysis; gives a number to compare against 3.02 s.
    - Cons: the dump stays ad hoc, as in 0163 and 0214.
  - **Only `mise run test`.**
    - Pros: cheapest.
    - Cons: a dropped test or a changed analysis passes silently.

## Current state

Every task is done. No file named in this todo is over 2,000 lines, and no
test was changed, added to or dropped by a split:

| Before | After | Tests (expectations) before and after |
| --- | --- | --- |
| `src/core/storage.test.ts` (4,322 lines) | `storage-shared-config.test.ts` 903, `storage-setup-build.test.ts` 1,410, `storage-pane-layout.test.ts` 599, `storage-model-catalogs.test.ts` 711, `storage.test.ts` 709 | 162 (505) |
| `tests/storage.test.ts` (2,855 lines) | `tests/storage-config.test.ts` 486, `tests/storage-records.test.ts` 905, `tests/storage-environment-activity.test.ts` 871, `tests/storage.test.ts` 554; helpers in `tests/storage-test-helpers.ts` | 74 (362) |
| `src/core/storage-agent-mail.test.ts` (2,292 lines) | `storage-agent-mail.test.ts` 1,539, `storage-agent-mail-routes.test.ts` 696; fixture in `agent-mail-storage-test-support.ts` | 50 (251) |
| `src/core/storage-writer-guards.test.ts` (2,487 lines) | analysis in `storage-writer-guards-test-support.ts` 1,700; `storage-writer-guards.test.ts` 205 (facade), `storage-writer-guards-raw.test.ts` 164 (raw writers), `storage-writer-guards-analysis.test.ts` 424 (fixtures) | 36 (155); 37 after the scan change, which adds one test |

The counts are from running each original file on its own and then the files
it became, with Bun 1.4.4. They differ from the Investigation of task 5,
which counted `test(` lines rather than running the tests (and was taken
before #1417 removed eight tests from `tests/storage.test.ts`).

The writer guard's raw-writer scan now parses only the files it can need (see
the task 4 decisions below). Its coverage is unchanged: a dump of the full
analysis (classes, area fields, store names, store summaries, every write
site with its paths, every raw write with its resolved store, the scanned
files and every `StorageContext` and repository identifier in the backend)
was taken at `cd7bbe3e5`, after the split and after the scan change. The last
two are byte-identical; the first differs only in three line numbers of
`storage-test-support.ts`, which task 1 gave one more import line.

Times for the raw-writer scan, old and new run back to back on the shared
Linux host:

| Measurement | Old | New |
| --- | --- | --- |
| `rawDatabaseWrites` alone, load average about 10 | 1,814, 1,543, 1,521 ms | 549, 530, 520 ms |
| `name the store they write` in `bun test storage --parallel=6` (65 files, 986 tests), load average 10–20 | 7,164 ms and 5,722 ms, both runs **failed** | 3,332 ms and 2,661 ms, both runs passed |
| `name the store they write`, focused `src/core/storage tests/storage` run, `--parallel=6`, load about 6.5 | not measured | 1,264 ms |

The failing old runs are flake 1309 reproducing on this branch's own
structure, which is the evidence that the new numbers are a fix rather than a
quiet host.

`mise run test` at `dda88f007` (load average 19–24) passed bridges and the
protocol lockfile. Every storage test and the writer guard passed. It failed
in two owners this branch does not touch:
`apps/backend/tests/codex-subagent-cards.test.ts` (the 0310 cold-restart
mismatch) and `tests/unit/mcp-fixture-cleanup.test.ts` (a 5 s deadline miss).
Both passed alone; they are recorded as flake case
[1316](../../tests/flaky-tests/aggregate-validation-runs/1316-storage-test-split-0930-validation.md).

## Assumptions and decisions

### The Task analysis against current `main` (all tasks)

The analysis was written against `79f3bc97e`. On 2026-10-30, at `cd7bbe3e5`,
nothing in it had been done: all four files were still over the limit and the
scan still parsed every backend file. One thing had moved: #1417 (looped
review removal) cut `tests/storage.test.ts` from 3,206 to 2,855 lines and
from 82 to 74 tests. That is still over the limit, so task 2 was still
needed. The backend had also grown from 820 to 952 non-test source files.

The delegation that started this work names the timeout flake 1304. The
flake is 1309: 1304 is an unrelated aggregate case (agent mail read model,
todo 0741). The backend-structure index row for this todo carried the same
slip; it now says 1309.

### Each split is a pure move, one commit each (tasks 1 to 4)

Chosen: whole `describe` blocks (or, in `tests/storage.test.ts`, whole
`test` calls) move verbatim, and the only other lines that change are imports
and the shared helpers named below. Each split was checked by comparing the
multiset of non-import lines before and after (the only differences are the
helpers' `export` keywords and each new file's `afterEach`/`describe`
wrapper) and by running the original file and its replacements for the same
test and expectation counts. The scan change is a separate commit.

### Where `withTemporaryStorage` goes (task 1)

Options: a new small support module, as the recommended cut suggested; or
`storage-test-support.ts`. Chosen: `storage-test-support.ts`, appended at its
end. It is already the module every storage test imports for seeding and
inspection (`AGENTS.md`, "Storage rules"), so a second support module would
split one job across two files. Appending at the end keeps the writer
guard's view of that file unchanged apart from the one import line it needed.

### How `tests/storage.test.ts` is cut (task 2)

Options: the recommended `storage-config`, `storage-records` and
`storage-leases` files with Kanban left behind; or a cut by what the tests
cover now. Chosen: `tests/storage-config.test.ts`,
`tests/storage-records.test.ts`, `tests/storage-environment-activity.test.ts`,
with Kanban, notes, feature plans and the Linear/GitHub completion tests (and
the `sharp` mock) left in `tests/storage.test.ts`. The current code shows the
recommended cut is wrong in one place: the lease tests are only five, and
they belong to two different subjects (environment mutation lock recovery,
the GitHub completion transaction lock). A leases file would take them away
from the tests they guard. Agent activity, meanwhile, is 22 tests and about
860 lines, the largest single subject in the file, and gets its own file.
Every moved test keeps its `Electron StorageService` describe, so its full
name is unchanged. The temp-dir, fixed-date and lease helpers move to
`tests/storage-test-helpers.ts`. Only `tests/storage.test.ts` uses the
`sharp` mock, so it is the only file that registers it.

### How the agent mail file is cut (task 3)

Chosen: the recommended option, moving the routes block as it is. The shared
`fixture()` and `StoredMail` go to `agent-mail-storage-test-support.ts`. The
name deliberately does not start with `storage`, because the writer guard
reads every `storage*.ts` file in `src/core` as storage source.

### Where the guard's analysis lives (task 4)

Options: `storage-writer-guards-analysis.ts` with an exclusion, as
recommended; a file outside `src`; or a `*-test-support.ts` name. Chosen:
`storage-writer-guards-test-support.ts` in `src/core`, beside the tests.
The `*test-support*` name is the repository's convention for test-only
modules, and `.oxlintrc.json` already gives those the test lint overrides.
It also leaves `storage-writer-guards-analysis.test.ts` free for the
analysis-fixture tests, the block that tests the analysis itself. The module
leaves itself out of both source lists by its own path (`import.meta.path`),
so the guard scans exactly the files it scanned before. `storage-test-support.ts`
stays scanned, as it was. The facade tests keep the name
`storage-writer-guards.test.ts`, which `AGENTS.md`, `storage.md` and several
repository comments cite.

### How the scan is made cheaper (task 4)

Chosen: the recommended option, with these specifics:

- `rawDatabaseWrites` parses a file only when its text can name a raw writer
  method (`RAW_WRITERS`), when a store name being resolved imports from it
  (`moduleOf`), or when it can call a row helper whose store parameter is
  being followed (`callsOf`). An import is matched to the declaring module by
  resolved path, before anything is parsed.
- The text check is exact in the direction that matters: it can keep a file
  the old scan would have found nothing in, but never drop one the old scan
  would have. It matches whole identifiers, and when a file contains `\u` it
  matches again on the text with escapes decoded. Without that, a write
  spelled `database.rows(...)` would slip past. A new fixture test,
  `still finds writes and helper callers that only an escape spells`, pins
  it; with the decoding removed that test fails.
- `parse()` keeps each tree by file, so the scans in one test file parse a
  file once. A source a test rewrote has different text and is parsed afresh.
  Since the split, `rawDatabaseWrites` and `identifiersOutside` run in
  different test files, so this sharing is per file: in the raw-writer file
  the storage sources the StorageService analysis already parsed are reused,
  and in the facade file `scannedFiles`, `identifiersOutside` and the
  primitive-callers check share theirs.
- Not done: building the scan in a `beforeAll` with a longer timeout (that
  raises the budget, which `AGENTS.md` forbids), or caching it in a separate
  process or artefact (it could go stale).

One property did change. The old scan parsed every backend file, so a backend
file with a syntax error failed this test even when it held no raw write. The
new one parses only the files it needs. Typecheck and every test that imports
such a file still catch it, and the guard's subject is store writes, not
syntax, so this is not a gap in what the guard proves.

What remains of the first test's cost is the StorageService analysis (about
0.25 s on a quiet host) and parsing about 126 files. Ten `callsOf` text
scans over all 952 files cost about 12 ms each. Further cuts there were not
worth the extra code.

### What proves the result (task 5)

Chosen: the recommended option. It covers the same test counts per file
before and after, the guard dump compared before and after the scan change,
the guard test's time in the focused `--parallel=6` storage run, then
`mise run test`. The old and new scans were also timed back to back in the
same wide run, because a single new number on a shared host proves little
(see **Current state**). The dump stays ad hoc, as in 0163 and 0214.

### Flake 1309 (task 4)

Marked resolved, with the evidence above. The old scan timed out in both
loaded runs; the new one passed both, at about half the time. The case file
records that a load far above 20 could still push the test past 5 s, which
would reopen it rather than call for a new case.

## Constraints and rationale

- Size, readability and test-budget work only: no production code changes.
- Don't skip the timed-out guard test or raise its timeout (`AGENTS.md`, "Flaky Test Tracking").

## Related

- [`storage.md`](../../architecture/storage.md#code-layout): the split sources and the agent mail collaborators, from todos 0214 (which recommended this follow-up) and 0163, both retired on 2026-10-29.
- Flake [1309](../../tests/flaky-tests/backend-services-and-tooling/1309-storage-writer-guard-raw-scan-timeout.md).
