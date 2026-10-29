# Storage test files over the size limit, and the writer guard's scan budget

## Task analysis

Analysed 2026-10-29 against `main` at `79f3bc97e`.

### Tasks

1. **Split `apps/backend/src/core/storage.test.ts` by topic**: 4,322 lines, 22 top-level `describe` blocks. Status: open.
2. **Split `apps/backend/tests/storage.test.ts` by area**: 3,206 lines, one `describe` with 82 tests. Status: open.
3. **Split `storage-agent-mail.test.ts` along the agent mail collaborators**: 2,292 lines. Status: open.
4. **Split `storage-writer-guards.test.ts` and bring its raw-writer scan within budget**: 2,481 lines; the scan test times out under host load (flake [1304](../../tests/flaky-tests/backend-services-and-tooling/1304-storage-writer-guard-raw-scan-timeout.md)). Status: open.
5. **Qualification**: the same test counts before and after, then `mise run test`. Status: open (after 1 to 4).

### 1. Split `apps/backend/src/core/storage.test.ts` by topic

**Problem.** The file is more than twice the 2,000-line guideline in `AGENTS.md`. Since 0214, its sources live in `storage-shared-<topic>.ts` modules and per-area repositories, but the tests for all of them still sit in one file. Anyone changing one config field or catalogue cache has to read the whole thing.

**Context.** [0214](0214-storage-files-over-size-limit.md) (decision "Should the over-limit storage test files be handled too?") recommended a new todo for the storage test files it left over the limit. This is that todo. `AGENTS.md` asks for tests to be split to match their sources.

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

**Context.** [0163](0163-storage-facade-size.md) split `AgentMailRepository` into `AgentMailStore`, `AgentMailboxDirectory`, `AgentMailInjects` and `AgentMailBudgets`. The tests did not follow.

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

**Context.** The full diagnosis is in flake [1304](../../tests/flaky-tests/backend-services-and-tooling/1304-storage-writer-guard-raw-scan-timeout.md). `AGENTS.md` ("Flaky Test Tracking") forbids hiding a flake by loosening the test.

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

## Constraints and rationale

- Size, readability and test-budget work only: no production code changes.
- Don't skip the timed-out guard test or raise its timeout (`AGENTS.md`, "Flaky Test Tracking").

## Related

- [0214-storage-files-over-size-limit.md](0214-storage-files-over-size-limit.md): split the sources and recommended this follow-up.
- [0163-storage-facade-size.md](0163-storage-facade-size.md): the agent mail collaborators.
- Flake [1304](../../tests/flaky-tests/backend-services-and-tooling/1304-storage-writer-guard-raw-scan-timeout.md).
