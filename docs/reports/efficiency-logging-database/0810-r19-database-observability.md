# Database observability

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Size and retention in `/metrics`**: file, WAL and freelist bytes, backup count and bytes, the last retention report. Status: open.
2. **Lease and transaction waits**: histograms, busy counts and a log line on lease timeout. Status: open.
3. **Top tables**: sampled per-table bytes, off the hot path. Status: open.
4. **Settings → Storage panel**: show it to the user. Status: open (depends on 1 and 3).

### 1. Size and retention in `/metrics`

**Problem.** The database grew to about 90% change-tracking rows on the machine sampled without anything showing it. Only manual SQL found it.

**Context.** The report cites "D9" in this recommendation's title. There is no D9 finding; M6 is the source.

**Investigation.** `livePageBytes` exists but only backups call it (`storage-database.ts:934`, `storage-backups.ts:579`). `releaseFreePages` reads the freelist (`storage-database.ts:958`). `handleMetrics` has no database field (`apps/backend/src/gateway-handlers.ts:337-358`). `ChangeRetentionService.run` returns a `RetentionReport` (`retention.ts:32-42`) that `service.ts:242` discards with `.catch(() => undefined)`, which is the L4 item this file takes. `get_log_storage_stats` (`commands-registry-environments.ts:115`) is the existing shape for a stats command.

**Decisions.**

- **Where do these get read?**
  - **A cached summary refreshed at most once a minute, read by `/metrics` (recommended).**
    - Pros: `/metrics` stays cheap; `stat` plus two PRAGMAs is small but must not run per request; R12 can read the same summary.
    - Cons: figures can be a minute old.
  - **Compute per request.**
    - Pros: always current.
    - Cons: adds to the cost M5 already complains about: each `/metrics` GET reaches SQLite.

### 2. Lease and transaction waits

**Problem.** Lease contention looks like generic event-loop stalls, and a timeout is only a thrown message.

**Context.** Report D8 estimates the cost. No figures have been measured.

**Investigation.** `acquireLease` polls with 25 ms sleeps and throws `Timed out waiting for ${description} lock` (`storage-database.ts:1308`). `busy_timeout` errors surface only as exceptions at callers; the only explicit `SQLITE_BUSY` handling is in `bridge-runtime-install.ts:251`. Lease rows hold `heartbeat_at`, so a holder's age is readable.

**Decisions.**

- **What is the minimum?**
  - **A `warn` on timeout with the lease name and holder age, plus one fixed-bucket wait histogram per lease family (recommended).**
    - Pros: names leases by family (`native-agent-session-leases/*`), so the series stay bounded; both answer "who is waiting on whom".
    - Cons: each acquire reads the clock and records; lease names need a family mapping.
  - **Only the log line.**
    - Pros: trivial.
    - Cons: shows failures, not the contention that precedes them.

### 3. Top tables

**Problem.** Knowing the file is large is less useful than knowing which table.

**Context.** The report warns `dbstat` scans and is not free on a 1 GB file, and suggests the backup child.

**Investigation.** No `dbstat` query exists in the code. The child copy (`storage-backups.ts:223`, `:304-313`) already runs at low priority at most hourly.

**Decisions.**

- **Where does `dbstat` run?**
  - **In the backup child, on the finished copy, written beside the snapshot's verification (recommended).**
    - Pros: never touches the live file or the event loop; a natural hourly cadence.
    - Cons: no data when no copy runs, for example when nothing changed; needs `dbstat` compiled into Bun's SQLite.
  - **`page_count` per table from a cheap approximation (row counts).**
    - Pros: no `dbstat` dependency.
    - Cons: row counts say little about bytes, and `COUNT(*)` scans too.

### 4. Settings → Storage panel

**Problem.** The user should be able to see this without a command.

**Context.** Report: file sizes, top tables, backups. Settings has log storage stats today; no database section.

**Investigation.** `GlobalSettings.tsx:565-579` fetches log stats on demand per machine, which is the pattern to copy.

**Decisions.**

- **Panel or part of Debug?**
  - **A section in Settings → Debug beside log storage (recommended).**
    - Pros: small; the same audience as log storage.
    - Cons: a user with a full disk may not look under Debug.
  - **A new Settings → Storage page, as the report names.**
    - Pros: discoverable; room for backups and retention.
    - Cons: a page with little else on it yet.

## Constraints and rationale

- Metrics stay content-free: table names and sizes only, never keys or paths.
- `/metrics` additions must be additive (`gateway-handlers.ts:349-356` comments follow this).

## Needs verification

- Whether Bun 1.4.4's SQLite (`mise.toml:2`) includes `dbstat` was not checked. The report's aggregates may have used another SQLite.

## Related

- [Logging and database report, R19](../2026-10-29-logging-and-database-efficiency.md#r19-database-observability-m6-d9) and [the metrics findings, M6](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [0720](0720-r6-silent-failure-logging.md), [0780](0780-r11-export-diagnostics.md), [0820](0820-r12-rolling-health-summary.md)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1 needs this kind of baseline number.
