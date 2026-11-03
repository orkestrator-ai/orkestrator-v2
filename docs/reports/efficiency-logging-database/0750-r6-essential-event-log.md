# An always-on essential event log

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide the stance**: confirm that a small content-free log may be written with saving off. Status: open.
2. **Add the sink**: a bounded store written whatever **Save Logs to Disk** says. Status: open (depends on 1).
3. **Choose what enters it**: errors and a curated list of lifecycle events. Status: open (depends on 2).
4. **Say so in Settings**: a read-only note. Status: open (depends on 2).

### 1. Decide the stance

**Problem.** With saving off, which is the default, nothing is kept, so the first occurrence of any problem is lost and a user has to reproduce it.

**Context.** The report recognises this reverses "nothing persisted unless enabled". The privacy rule is AGENTS.md invariant 12.

**Investigation.** The writer returns at once when saving is off (`packages/protocol/src/node/application-logging.ts:452`). `debugLogging` defaults to false (`packages/protocol/src/app-config-defaults.ts:92`).

**Decisions.**

- **May the app write this by default?**
  - **Yes, provided every entry is an event and scalars, with no error message (recommended).**
    - Pros: first-occurrence evidence, which is the report's "defaults should favour less, but never zero"; tens of KB a day by its estimate.
    - Cons: a user who turned saving off still has a small file on disk; Settings must say so.
  - **No, keep the current stance.**
    - Pros: simple to state; nothing written.
    - Cons: crashes and silent fallbacks stay unexplained unless reproduced.

### 2. Add the sink

**Problem.** There is no store independent of the debug log.

**Context.** The report offers a rotating 1 to 4 MiB file under `logs/essential/`, or a 1,000-row SQLite ring, and prefers the file.

**Investigation.** Electron's main process writes the file today, with the backend's lines relayed to it, and a standalone backend writes its own through the same writer. The log directory sweep handles nested directories (`apps/desktop/electron/application-logging.test.ts:459-469`). `get_log_storage_stats` stats the whole tree (`commands-registry-environments.ts:115`), so the size shown would include this.

**Decisions.**

- **File or SQLite?**
  - **A rotating file under `logs/essential/`, capped at 4 MiB, outside the retention sweep (recommended).**
    - Pros: works when the database is the failing part; no more writes to a busy database.
    - Cons: not queryable; **Clean up logs** and the sweep must be taught to leave it.
  - **A ring table in SQLite.**
    - Pros: queryable; backs up for free.
    - Cons: a migration failure cannot be recorded in the database that failed; adds fsynced writes.
- **Which process owns it?**
  - **Whichever process owns the log file today: the desktop in the app, the backend when standalone (recommended).**
    - Pros: one writer per file; survives a backend crash in the app, which is the point.
    - Cons: a desktop crash is not captured by itself; only its next start can say so.
  - **The backend always.**
    - Pros: one code path.
    - Cons: loses its own last lines when it dies in the app.

### 3. Choose what enters it

**Problem.** The list must be small and reviewable.

**Context.** The report lists: backend and bridge start and exit, writer lease lost or regained, resume fallback, migration and snapshot failures, stalls of 10 s or more, Docker bridge relaunch and unhandled rejections. L4 also notes no backend `uncaughtException` handler.

**Investigation.** `error` is never filtered, and `event-loop` `stalled` at 10 s or more is written at `error` (`docs/architecture/logging.md:586-588`). `formatLogError` keeps a message, which can hold a path (`logging.md:252-254`). The fatal rejection guard is installed at `apps/backend/src/main.ts:63` and uses raw console. The backend has no `uncaughtException` handler; the desktop does (`apps/desktop/electron/native-dialogs.ts:232`), and there is no `crashReporter`.

**Decisions.**

- **How is an event marked?**
  - **An `essential: true` flag on the event in `log-vocabulary/` (recommended).**
    - Pros: reviewed where the event is defined; `log-vocabulary.test.ts` can enforce that its fields are scalars.
    - Cons: the vocabulary gains a field, and `error` entries need their message stripped separately.
  - **A separate `log.essential(...)` call.**
    - Pros: visible at the call site.
    - Cons: a site can use it with any fields; review is scattered.
- **Backend `uncaughtException`?**
  - **Add a handler that writes one essential entry and then lets the process die as it does now (recommended).**
    - Pros: closes the gap L4 names, with no change in behaviour.
    - Cons: the behaviour under Bun needs confirming first.
  - **Leave it.**
    - Pros: nothing to change.
    - Cons: the crash this tier exists for may leave nothing.
- **Electron `crashReporter`?**
  - **No action (recommended).**
    - Pros: the report treats "nothing leaves the machine" as a deliberate default, and a local-only minidump is not content-free.
    - Cons: a native crash stays unexplained beyond its exit signal.
  - **Enable it with uploads off.**
    - Pros: native crash evidence.
    - Cons: minidumps hold process memory, against the rule this tier relies on.

### 4. Say so in Settings

**Problem.** A user must be able to see this exists.

**Context.** The report's control table gives it a read-only note.

**Investigation.** Settings → Debug has **Save Logs to Disk** and **Log Detail** (`GlobalSettings.sections.tsx:2182`, `:2320`) and no such note.

**Decisions.** None: one sentence under **Save Logs to Disk**, and `get_log_storage_stats` reporting it separately.

## Current state

The events it needs partly exist. [0720](0720-r6-silent-failure-logging.md) adds the rest. Nothing here has been built.

## Constraints and rationale

- Entries must hold no prompts, tokens, paths or file contents. A message from `formatLogError` is not safe enough here: use `{ message: false }`.
- [0780](0780-r11-export-diagnostics.md) reads this log, and [0790](0790-r8-renderer-diagnostics.md) may write to it.

## Open questions

- Task 1 is the user's call, because it changes a privacy stance.

## Needs verification

- What Bun does with an uncaught exception after a handler returns was not run.
- The report's tens of KB a day is an estimate.

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [Proposed user controls](../2026-10-29-logging-and-database-efficiency.md#proposed-user-controls)
- [Application logging](../../architecture/logging.md)
