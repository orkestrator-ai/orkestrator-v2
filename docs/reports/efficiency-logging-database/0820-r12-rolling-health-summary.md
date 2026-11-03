# Persist a small rolling health summary

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Periodic summary row**: every 5 minutes, one content-free row in a bounded store. Status: open.
2. **Clean shutdown marker**: tell "crashed" from "quit" at the next start. Status: open.

### 1. Periodic summary row

**Problem.** Every in-memory metric resets on restart and nothing records memory or CPU, so "is it leaking?", "why did it restart?" and "which job burns CPU?" cannot be answered afterwards.

**Context.** The report proposes 2,016 rows (7 days), about 300 small writes a day, which it calls trivial. Most sources already exist.

**Investigation.** `process.memoryUsage` appears only in `apps/backend/scripts/remote-bandwidth-baseline.ts`, never under `src`. `handleMetrics` already assembles recurring work, event-loop and console figures (`apps/backend/src/gateway-handlers.ts:350-356`). DB bytes are [0810](0810-r19-database-observability.md)'s. Bridge restarts have no counter. Bounded stores with their own guards exist to copy: `compatibility-path-usage` merges once a minute (`compatibility-path-usage.ts`), and `usage-history` prunes by age and count (`usage-history-store.ts:296-323`). Scheduled work runs through `RecurringWorkMetrics`-aware jobs in `core/index.ts`.

**Decisions.**

- **Store?**
  - **A `health-summary` store on `StorageDatabase.rows()`, one row per sample, pruned in the write transaction (recommended; the report's choice).**
    - Pros: queryable; survives restarts; the raw writer guard covers it.
    - Cons: a few more fsynced commits on a busy database; part of every hourly copy until [0760](0760-r17-ledger-out-of-hourly-snapshots.md).
  - **A JSONL file beside the logs.**
    - Pros: no database writes; still readable when storage is the problem.
    - Cons: another bounded file to rotate, and nothing queries it.
- **Which backend writes when several share a directory?**
  - **Each writes its own rows, keyed by instance id, with the bound per directory (recommended).**
    - Pros: a second backend's health is what someone may be investigating.
    - Cons: two backends halve the history.
  - **Only the registry writer.**
    - Pros: one series.
    - Cons: nothing recorded for the other, and lost lease means no rows at all.

### 2. Clean shutdown marker

**Problem.** The next start cannot tell a crash from a quit.

**Context.** `core/index.ts:2878` sets `shuttingDown` on the orderly path. The report feeds this into R11 and possibly a Health page.

**Investigation.** The instance descriptor already records `pid` and `startedAt` (`packages/protocol/src/node/bug-report-facts.ts:49-65` reads them; `apps/backend/src/instance-descriptor.ts` writes them). A previous run's descriptor at start therefore already suggests something, but a pid can be reused.

**Decisions.**

- **Where is the marker?**
  - **A row in the same store: `started` at start, `clean-exit` as the last shutdown step, and one `previous-run=crashed|clean` log line at start (recommended).**
    - Pros: one source; the log line reaches a saved log and the essential log.
    - Cons: a SIGKILL or power loss reads as crashed, which is correct, but a shutdown failing late also does.
  - **A marker file next to the descriptor.**
    - Pros: works if the database cannot be opened.
    - Cons: another file whose ownership matters when backends share a directory.

## Constraints and rationale

- Rows hold numbers and job kinds only. Recurring-work kinds are already bounded and content-free.
- The sample must not itself be a recurring job that distorts the numbers it reports. Keep it to one timer.

## Needs verification

- Whether `process.memoryUsage` under Bun reports what an RSS leak needs was not run.

## Related

- [Logging and database report, R12](../2026-10-29-logging-and-database-efficiency.md#r12-persist-a-small-rolling-health-summary-m1) and [the metrics findings, M1](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [0741 backend responsiveness under load](../../todo/cross-cutting/0741-backend-responsiveness-under-load.md), which collected process figures by hand
- [0780](0780-r11-export-diagnostics.md), [0810](0810-r19-database-observability.md)
