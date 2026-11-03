# Stop the scrub checkpoint stalling the event loop during a backup

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Confirm the stall**: reproduce or rule out a delete blocking during an hourly copy. Status: open.
2. **Avoid blocking in `scrubDeletedContent`**: without weakening the scrub. Status: open (depends on 1).

### 1. Confirm the stall

**Problem.** A delete during the hourly copy may block the backend's event loop for up to the busy timeout. The report inferred this from SQLite semantics and did not reproduce it.

**Context.** The signature would be an `event-loop` `stalled` line of about 10 s coinciding with an hourly copy.

**Investigation.** `busy_timeout` is 10 s by default (`storage-database.ts:285`). The backup child sets its own (`storage-backups.ts:312`) and holds a read snapshot across `VACUUM INTO` (`:313`). `scrubDeletedContent` is synchronous on the event loop (`storage-database.ts:922-931`).

**Decisions.**

- **How to confirm?**
  - **A test that holds an open read transaction on a second connection, calls `scrubDeletedContent`, and times it (recommended).**
    - Pros: no real data or live run; proves the mechanism on Bun's SQLite on each OS.
    - Cons: does not show how often it happens in use.
  - **Search saved logs for matching stall lines.**
    - Pros: real frequency.
    - Cons: needs a machine with saving on, and a match is only circumstantial.

### 2. Avoid blocking in `scrubDeletedContent`

**Problem.** A truncating checkpoint invokes the busy handler until every reader moves on.

**Context.** The scrub is a documented guarantee: `docs/architecture/storage.md:370-374`, tested by `storageFilesContain`. The report also notes a long reader stops `journal_size_limit` bounding the WAL. Its "when no backup lease is held" has no referent: the hourly copy takes no lease (`storage-backups.ts`, `copyDatabaseInChildProcess`), so that signal would have to be added. Moving the ledger out ([0760](0760-r17-ledger-out-of-hourly-snapshots.md)) shortens the copy to milliseconds on the report's estimate, which removes most of the window but not the hazard.

**Investigation.** Callers are spread across deletion paths: `StorageContext` (`storage-context.ts:204`, `:841`, `:975`), display tails (`native-agent-display-tail-store.ts:293`), web annotations (`web-annotation-storage.ts:1589`), workflow results (`workflow-result-service.ts:1741`) and pipeline transcripts (`build-pipeline-transcript-store.ts:1252`), so the fix belongs inside the function. The function already treats failure as best effort ("the next checkpoint scrubs it"), though nothing guarantees a next checkpoint soon. `bridge-runtime-install.ts:243` shows a `busy_timeout = 0` pattern in this repo.

**Decisions.**

- **How to stop blocking?**
  - **PASSIVE in the delete path, and retry TRUNCATE from the maintenance loop while no copy runs (recommended; the report's choice).**
    - Pros: never waits for readers; truncation happens as soon as it can.
    - Cons: deleted content can stay in the WAL for longer, so the doc needs a time bound; needs a "copy running" signal.
  - **Keep TRUNCATE with `busy_timeout = 0` around it, retrying later on `SQLITE_BUSY`.**
    - Pros: smallest change; a quiet system still truncates at once.
    - Cons: the same deferred scrub under a reader, and a shared connection's timeout must be restored reliably.

## Constraints and rationale

- A failed scrub must leave evidence ([0720](0720-r6-silent-failure-logging.md) task 5) once it can be deferred for longer.
- Other backends on the same data directory can also hold readers, so a "copy running" flag in this process is not a full answer. The retry must still tolerate failure.

## Needs verification

- Whether Bun's linked SQLite invokes the busy handler in this path as the report infers, on each OS. Task 1 answers it.

## Related

- [Logging and database report, R18](../2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6) and [D6](../2026-10-29-logging-and-database-efficiency.md#d6-a-truncating-checkpoint-can-stall-the-event-loop-during-a-backup-medium-likely)
- [0741 backend responsiveness under load](../../todo/cross-cutting/0741-backend-responsiveness-under-load.md), which tracks event-loop stalls generally
- [0910](0910-r18-sqlite-maintenance.md), [0920](0920-r18-durability-tiers.md)
