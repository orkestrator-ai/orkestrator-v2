# Tier SQLite `synchronous` and `secure_delete` by data

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b` (task 3 done on macOS; first analysed 2026-11-05 at `69a3b4ca5`). Carried from part `0920` of the E5 efficiency batch (R18's tiers, D5), whose batch file was deleted when E5 landed. Its outcome is in the closing check of E5 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); the original text stays in git history at `69a3b4ca5`. The maintainer's deferral in [1202](1202-efficiency-review-follow-ups.md) task 2 (ST-12, "decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task") is kept: nothing here has been measured on a real session, which the deferral needs.

### Tasks

1. **Measure fsync and zero-write cost**: commits and fsyncs a minute in a busy real session, now that the ledger has its own file. Status: open (needs live evidence: a real provider turn).
2. **Decide the tiers**: with the maintainer's sign-off. Status: open (depends on 1).
3. **Check macOS `fsync` and `fullfsync` under Bun's linked SQLite**: the report's "Needs verification". Status: done (2026-11-10, macOS 27.2, Bun 1.4.4, system SQLite 3.54.0; `checkpoint_fullfsync` now set explicitly).

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
    - Pros: orders every commit's WAL sync with a write barrier.
    - Cons: does not make commits survive power loss: task 3 found Apple's SQLite maps it to `F_BARRIERFSYNC`, not `F_FULLFSYNC`, on APFS and HFS+. Costs about 0.5 ms more per commit (0.19 to 0.72 ms median on the internal SSD, task 3), against the point of this work.
  - **Leave all as it is.**
    - Pros: the current decision; simple to state.
    - Cons: a real cost stays if the measure finds one.

### 3. Check macOS `fsync` and `fullfsync` under Bun's linked SQLite

**Problem.** The report notes that `fsync` without `fullfsync` on macOS does not flush the drive cache, so `synchronous = FULL` may promise more there than it gives.

**Context.** Bun on macOS loads the system `libsqlite3.dylib`, so the behaviour follows the macOS release. The storage layer sets WAL and `synchronous = FULL` on the main file and NORMAL on the ledger (`StorageDatabase`'s constructor, `storage-database.ts`); before this task it set neither `fullfsync` nor `checkpoint_fullfsync`.

**Investigation.** Run on 2026-11-10 on mini: macOS 27.2 (build 26B123), Apple silicon, Bun 1.4.4, throwaway databases under `$TMPDIR` on the internal APFS SSD (and once on an external HFS+ SSD). Nothing touched a data directory. `scripts/benchmark-sqlite-sync.ts` reproduces the numbers.

- **Library.** `sqlite_version()` is 3.54.0 and `sqlite_source_id()` ends in `aapl`; `compile_options` include `CCCRYPT256`, `DEFAULT_CKPTFULLFSYNC`, `DEFAULT_SYNCHRONOUS=2` and `DEFAULT_WAL_SYNCHRONOUS=1`. So Bun runs Apple's build, not its own.
- **Defaults on a fresh connection.** `fullfsync = 0`, `checkpoint_fullfsync = 1`.
- **Which call a sync makes.** `dyld_info -disassemble /usr/lib/libsqlite3.dylib`, function `_unixSync`: the command is `F_BARRIERFSYNC` (0x55) when the sync is `SQLITE_SYNC_FULL` (what `fullfsync` and `checkpoint_fullfsync` request), else none; it becomes `F_FULLFSYNC` (0x33) only when a per-file flag is set, which `_unixOpen` sets for a file-system type named `lifs` and one other open-time condition not identified. With no command, or if `fcntl` fails, it calls `fsync`. So on APFS and HFS+: a FULL commit with `fullfsync` off calls `fsync`; with `fullfsync` on, `F_BARRIERFSYNC`; a checkpoint with `checkpoint_fullfsync` on, `F_BARRIERFSYNC`. Interposing `fcntl`/`fsync` with `DYLD_INSERT_LIBRARIES` saw Bun's own calls but none from SQLite (calls within the shared cache are bound directly), and `fs_usage`/`dtruss` need root, so the disassembly and the timing below are the evidence.
- **Timing, internal APFS SSD**, one-row commit and raw call after a 4 KiB append, interleaved 200 times, median (p95):

| Series | Median ms | p95 ms |
| --- | --- | --- |
| FULL, `fullfsync` off (main file today) | 0.193 | 0.717 |
| FULL, `fullfsync` on | 0.716 | 3.635 |
| NORMAL (ledger today) | 0.054 | 0.186 |
| OFF (floor) | 0.028 | 0.115 |
| raw `fsync` | 0.076 | 0.203 |
| raw `F_BARRIERFSYNC` | 0.703 | 2.162 |
| raw `F_FULLFSYNC` | 4.098 | 8.744 |

  A `fullfsync = ON` commit costs what a barrier costs and a sixth of a real `F_FULLFSYNC`, matching the disassembly. A truncating checkpoint after 50 commits took 1.66 ms median with `checkpoint_fullfsync` on and 0.46 ms off. An earlier non-interleaved run gave the same picture (0.83 ms against 3.9 ms for `F_FULLFSYNC`).
- **External HFS+ SSD** (`/Volumes/verbatim`): `F_FULLFSYNC` and `F_BARRIERFSYNC` both cost about 0.94 ms, so the timing cannot tell them apart there; the disassembly still applies.

**Outcome.**

- `synchronous = FULL` on macOS gives application- and OS-crash durability, not power-loss durability: a power cut can lose the last commits (WAL checksums end recovery at the first torn frame, so no corruption). `storage.md` said "survives a crash" without saying which; it now says so.
- Turning `fullfsync` on cannot fix that on APFS or HFS+ under this library, so task 2's third option was described wrongly; corrected above. There is no PRAGMA that gets `F_FULLFSYNC` per commit here.
- Checkpoint ordering, which protects the database file itself, rested on Apple's `DEFAULT_CKPTFULLFSYNC` build option rather than on anything the code set. `StorageDatabase` now sets `checkpoint_fullfsync = ON` on every connection (main and ledger), pinned by a test in `storage-database-upkeep.test.ts`. That is the current behaviour on macOS, not a durability change, and a no-op on Linux.

**Decisions.**

- **How to check?**
  - **Read `PRAGMA fullfsync` and `PRAGMA checkpoint_fullfsync` on a macOS backend connection, and time a commit loop with each (recommended; done, plus the library's disassembly).**
    - Pros: answers the question directly and gives the cost of turning it on.
    - Cons: needs a macOS host.
  - **Assume the default (`fullfsync` off) and document it.**
    - Pros: no host needed.
    - Cons: leaves the cost unknown for task 2's third option.

## Current state

- The ledger file already runs `synchronous = NORMAL` (#1996, `d9b46f30e`, 2026-11-09), task 2's first option. Tasks 1 and 2 stay open: the maintainer's deferral asked for a measurement first, and whether #1996 settles task 2 is the maintainer's call.
- macOS numbers for task 2 are in task 3: a commit costs about 0.19 ms (FULL), 0.05 ms (NORMAL) and 0.72 ms (FULL with `fullfsync`) on mini's internal SSD.

## Constraints and rationale

- Re-rate this file when task 1 has numbers; it is Low because the maintainer deferred it pending that measurement.
- A durability change needs the maintainer's sign-off.

## Assumptions and decisions

### Task 3: pin `checkpoint_fullfsync` rather than inherit it

Chose to set `PRAGMA checkpoint_fullfsync = ON` in `StorageDatabase`'s constructor. Alternatives: leave the library default (no code, but the checkpoint's write barrier would silently vanish under a SQLite build without `DEFAULT_CKPTFULLFSYNC`, such as one loaded with `Database.setCustomSQLite`); or also turn `fullfsync` on (a barrier per commit, about 0.5 ms each, and still no power-loss durability). Pinning changes no behaviour on today's macOS or on Linux, so it needs no durability sign-off; `fullfsync` per commit is a durability and cost change and stays with task 2.

### Task 3: timing plus disassembly as the evidence

`fs_usage` and `dtruss` need root, which this build did not use, and `DYLD_INSERT_LIBRARIES` interposition does not see calls between shared-cache libraries. So the evidence is the library's own `_unixSync` disassembly plus interleaved timing against raw `fsync`, `F_BARRIERFSYNC` and `F_FULLFSYNC` calls. A later run on another macOS release can repeat both with `scripts/benchmark-sqlite-sync.ts` and `dyld_info`.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md) tasks 1 and 2 (ST-12)
- [5181](5181-sqlite-cache-sizes.md), [5182](5182-database-upkeep-live-evidence.md)
- [Backend storage: Durability and deletion](../../architecture/storage.md#durability-and-deletion)
- Logging and database report, R18 and D5 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
