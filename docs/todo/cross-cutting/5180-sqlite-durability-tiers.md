# Tier SQLite `synchronous` and `secure_delete` by data

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from part `0920` of the E5 efficiency batch (R18's tiers, D5), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. The maintainer's deferral in [1202](1202-efficiency-review-follow-ups.md) task 2 (ST-12, "decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task") is kept: nothing here has been measured on a real session, which the deferral needs.

### Tasks

1. **Measure fsync and zero-write cost**: commits and fsyncs a minute in a busy real session, now that the ledger has its own file. Status: open (needs live evidence: a real provider turn).
2. **Decide the tiers**: with the maintainer's sign-off. Status: open (depends on 1).
3. **Check macOS `fsync` and `fullfsync` under Bun's linked SQLite**: the report's "Needs verification". Status: open (needs a macOS host).

### 1. Measure fsync and zero-write cost

**Problem.** The report estimates 600 to 1,000 fsynced commits a minute in a busy session, dominated by change tracking. That was reasoned, not counted.

**Context.** E5 moved the change-tracking ledger into its own file, `change-tracking.sqlite` (storage migration 7, `change-tracking/ledger-schema.ts`), with its own connection and the same settings as the main file: WAL, `synchronous = FULL`, `secure_delete = ON` (`StorageDatabase`'s constructor, `storage-database.ts`). So the two files can now be tiered independently without any further move. Durability changes need the maintainer's sign-off (1202, "Constraints and rationale").

**Investigation.** Nothing counts commits or fsyncs today; lease waits and `SQLITE_BUSY` counts now exist ([storage](../../architecture/storage.md#size-waits-and-what-fills-the-file)), but commits are not timed. The measurement-rows workload (`scripts/benchmark-change-tracking.ts`) runs with `durable: false`, so it cannot stand in for real fsyncs; a busy real session needs a real provider turn, which a build may not run. 1202 task 1 owns baseline numbers.

**Decisions.**

- **How to count?**
  - **A commit counter per connection, read from `/metrics`, during a busy real session on an isolated profile (recommended).**
    - Pros: counts what the deferral asks about, split by file; no content in the numbers.
    - Cons: needs a real provider turn; a counter is new code on the hot write path, though a cheap one.
  - **`strace -c -e fsync,fdatasync` on the backend during the same session.**
    - Pros: counts real syscalls, including WAL syncs at checkpoints; no code change.
    - Cons: Linux only, and it attaches to a process that shares the host with production.

### 2. Decide the tiers

**Problem.** `synchronous = FULL` and `secure_delete = ON` apply to all data, while the privacy and durability cases differ per store.

**Context.** Ledger rows hold counts, object ids and encoded paths, while evidence bodies and file contents are files outside the database (`ledger-schema.ts`), so `secure_delete` on the ledger protects less than on mail or prompts. `docs/architecture/storage.md`, "Durability and deletion", documents the settings and the scrub guarantee.

**Investigation.** With its own file, the ledger would set its settings in `openChangeLedgerDatabase` after opening. `StorageDatabaseOptions` has no setting for them yet.

**Decisions.**

- **What to change, if the measure justifies anything?**
  - **Ledger file to `synchronous = NORMAL`; leave everything else (recommended).**
    - Pros: largest saving on the rows the report blames; loses only the last few transactions on power loss, with no corruption; `secure_delete` and the documented scrub stay whole.
    - Cons: one file's commits differ; a turn's last measurement could vanish on power loss.
  - **Also `secure_delete = FAST` on the ledger and display tails.**
    - Pros: fewer zero-writes on the highest churn.
    - Cons: deleted content can stay in free pages until reused, which weakens the scrub guarantee for display tails, which hold transcript text.
  - **`synchronous = FULL` plus `fullfsync = ON` on macOS for app stores.**
    - Pros: makes the durability `storage.md` implies real.
    - Cons: slower commits, against the point of this work.
  - **Leave all as it is.**
    - Pros: the current decision; simple to state.
    - Cons: a real cost stays if the measure finds one.

### 3. Check macOS `fsync` and `fullfsync` under Bun's linked SQLite

**Problem.** The report notes that `fsync` without `fullfsync` on macOS does not flush the drive cache, so `synchronous = FULL` may promise more there than it gives.

**Context.** Bun on macOS loads the system `libsqlite3.dylib`, so the behaviour follows the macOS release.

**Investigation.** Not checked: no macOS host was available to this build.

**Decisions.**

- **How to check?**
  - **Read `PRAGMA fullfsync` and `PRAGMA checkpoint_fullfsync` on a macOS backend connection, and time a commit loop with each (recommended).**
    - Pros: answers the question directly and gives the cost of turning it on.
    - Cons: needs a macOS host.
  - **Assume the default (`fullfsync` off) and document it.**
    - Pros: no host needed.
    - Cons: leaves the cost unknown for task 2's third option.

## Constraints and rationale

- Re-rate this file when task 1 has numbers; it is Low because the maintainer deferred it pending that measurement.
- A durability change needs the maintainer's sign-off.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md) tasks 1 and 2 (ST-12)
- [5181](5181-sqlite-cache-sizes.md), [5182](5182-database-upkeep-live-evidence.md)
- [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)
- Logging and database report, R18 and D5 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
