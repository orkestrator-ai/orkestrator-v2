# E15: Health and diagnostics

This file combines 5 reports into one batch to build together. Build the sources first. `0780` then packages them.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0750](#0750-an-always-on-essential-event-log) | Done | R6's always-on tier and control, plus L4's uncaught exception gap. Built; see [Application logging](../../architecture/logging.md#the-essential-event-log). |
| [0820](#0820-persist-a-small-rolling-health-summary) | Medium | R12 (M1): a rolling health row and a clean shutdown marker. |
| [0810](#0810-database-observability) | Medium | R19 (M6): database size, waits, top tables and a panel. |
| [0880](#0880-consolidate-metric-primitives) | Low | R13 (M3, M4, M5): write-only metrics, small inefficiencies and shared primitives. |
| [0780](#0780-an-export-diagnostics-bundle) | Medium | R11 (M2, L7) and its control: a local diagnostics bundle. |

## 0750: An always-on essential event log

### Task analysis

#### Tasks

1. **Decide the stance**: confirm that a small content-free log may be written with saving off. Status: done; the user agreed it.
2. **Add the sink**: a bounded store written whatever **Save Logs to Disk** says. Status: done.
3. **Choose what enters it**: errors and a curated list of lifecycle events. Status: done.
4. **Say so in Settings**: a read-only note. Status: done.

#### 1. Decide the stance

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

#### 2. Add the sink

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

#### 3. Choose what enters it

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

#### 4. Say so in Settings

**Problem.** A user must be able to see this exists.

**Context.** The report's control table gives it a read-only note.

**Investigation.** Settings → Debug has **Save Logs to Disk** and **Log Detail** (`GlobalSettings.sections.tsx:2182`, `:2320`) and no such note.

**Decisions.** None: one sentence under **Save Logs to Disk**, and `get_log_storage_stats` reporting it separately.

### Current state

Built. [Application logging](../../architecture/logging.md#the-essential-event-log) is the guide: the bounds, the full list of events and each one's fields, who writes the file in each setup, and what Bun does with an uncaught exception.

### Constraints and rationale

- Entries hold no prompts, tokens, paths or file contents. A message from `formatLogError` is not safe enough here, and `log-essential.ts` drops it wherever an error is attached.
- [0780](#0780-an-export-diagnostics-bundle) reads this log, and [0790](0790-e16-log-controls.md#0790-renderer-diagnostics-a-user-can-turn-on) may write to it.

### Open questions

None. Task 1 was the user's call, and they agreed the stance.

### Needs verification

- The report's tens of KB a day is an estimate, and no long-running installation has been sampled. What is bounded is the worst case: 4 MiB in total, and about 36 KB a day from any one event.
- That a real packaged app writes the file in its packaged paths needs a packaged build. The writer runs in every runtime flavor, and `renderer-log-boundary-electron.spec.ts` covers it through a real Electron main process and backend.

### Assumptions and decisions

#### Task 2: 4 files of 1 MiB

The ticket left the exact cap to the build. `essential.jsonl` plus 3 rotated files gives a hard 4 MiB. Fewer files would evict a larger share of the history at each rotation, and more would add files for no gain.

#### Task 2: always JSON lines

The file ignores `ORKESTRATOR_LOG_FORMAT`. Each line is the record shape `parseLogRecordLine` already reads, so a later reader has one format and a change of format between launches cannot mix two in one file.

#### Task 2: it runs in every runtime flavor

Unlike the saved log, the desktop installs it in development and agent-test profiles too. It holds nothing a profile could not keep, and `userData` is the profile's own directory, so this reaches no real data. It is also what lets a real Electron test read it. A standalone backend in an agent-test profile installs none, as it does for the saved log.

#### Task 2: a stop and a start bracket a run

The writer records `essential.started` and `essential.stopped` itself. A start with no stop before it means the last writer died, which is how the desktop-crash limitation can be read off the file. It is not the R12 clean shutdown marker in [0820](#0820-persist-a-small-rolling-health-summary), which also covers the backend in the app and sits in a store.

#### Task 3: fields are declared per event, and undeclared errors keep no free strings

The flag alone would have reviewed the event's name but not what a call site passes, so each definition lists its fields and only those are written. An `error` nobody flagged keeps numbers, booleans, an error's identity and a short list of fixed labels. Stripping only `message` from those entries would have kept any string field, such as a path, that an unreviewed site logs.

#### Task 3: what the curated list holds

Every event the ticket names exists and is flagged, with these new ones: `local-server` `bridge.started`, `docker` `bridge.launched`, `storage` `migration.failed` and the `process` area's `rejection.unhandled` and `uncaught-exception`. `session.resume-fell-back` keeps no session id, because it can be the provider's. A lost lease cannot be regained in the process that lost it, so the regained event, `docker` `writer-lease.regained` with `staleForMs`, is written by the backend that takes a stale lease over from a holder that stopped refreshing it; a lease released by a clean shutdown is acquired silently. `snapshot.skipped-low-disk` stays out as a skip rather than a failure. Stalls are flagged with `minLevel: "error"`, because the same event at `warn` is a routine short stall.

#### Task 3: the lease is regained by the backend that takes it over

The ticket lists the writer lease being regained. A lost lease is final for the process that lost it, and making it re-acquire would change lease behaviour, which the ticket rules out. So `writer-lease.regained` is written where a lease does come back: the stale-lease takeover in `RegistryWriterLease.acquire`, after the previous holder stopped refreshing it. It carries one number, `staleForMs`, the lease's age when it was removed. A lease released by a clean shutdown is acquired without a line, so the event marks only a takeover. Nothing about acquisition changed.

#### Task 3: `bridge.launched` covers a first start as well as a relaunch

The host cannot tell the two apart without another `docker exec`, and that one line is what the ticket's "Docker bridge relaunch" needs. The previous log, which `keepPreviousLogCommand` keeps, says which it was.

#### Task 3: the desktop's exit error now carries its code and signal as fields

`Backend service exited (code, signal)` held them only in its message, which this log strips. They were added as `exitCode` and `signal` on the error. The message and every reader of it are unchanged, and a saved line gains those two fields.

#### Task 3: a monitor, not an `uncaughtException` listener

A real run under Bun 1.4.4 showed a returning `uncaughtException` listener keeps the process alive, so the handler as the report described it could not preserve the behaviour. `uncaughtExceptionMonitor` does: the same dump, `exit` with code 1, and exit 1. It is shipped on that basis, and an integration test pins it against the runtime.

#### Task 3: the writer limits each event as well

`log.throttled` only helps sites that use it, and a plain `log.error` in a loop or an imitated record would still have evicted everything. So the writer gives each event a burst of 10 and one entry per 10 minutes. `rejection.unhandled` also uses `log.throttled`, as the ticket asks.

#### Task 3: a filtered entry crosses a relay marked

A level-filtered entry has to reach the owning process without reaching its normal log, so it crosses with `essentialOnly`. Having the receiver apply its own level instead would be wrong for a bridge whose override differs from the desktop's, and the relay's rule is that it never filters.

#### Task 2: an agent-test profile's backend now relays records

A live run in a `dev:test` profile found that the profile's environment allowlist removed `ORKESTRATOR_DESKTOP_SUPERVISED`, so its backend logged text and none of its entries could reach this log. Production was not affected. The flag now survives the allowlist, as it holds no secret, so a profile matches production. Its backend's lines in the desktop's console lose their `[Backend]` prefix as a result.

#### Task 3: a stale assertion in the Electron spec

`renderer-log-boundary-electron.spec.ts` refused a `Log level for terminal` control, but `logDetailAreas` keeps that shared area on purpose, as this guide says, so the spec failed on `main` whatever this work did. Its pattern now names `terminal.` only, which is what the setting actually excludes.

#### Task 4: the size is shown too

The ticket asks for the sentence, and for `get_log_storage_stats` to report the size separately. Settings also shows that size under **Stored logs**, and the **Clean up logs** dialog now says the event log stays. An older backend reports no such field, so the line is left out.

#### Out of this work

- A container bridge has no hop, so its `session.resume-fell-back` is not in this file. Reading it would mean the backend tailing container logs.
- The bug report prompt (`packages/protocol/src/bug-report.ts`) still asks for **Save Logs to Disk** to be turned on and does not mention this log. Pointing it here is a small follow-up, and fits [0780](#0780-an-export-diagnostics-bundle).

## 0820: Persist a small rolling health summary

### Task analysis

#### Tasks

1. **Periodic summary row**: every 5 minutes, one content-free row in a bounded store. Status: open.
2. **Clean shutdown marker**: tell "crashed" from "quit" at the next start. Status: open.

#### 1. Periodic summary row

**Problem.** Every in-memory metric resets on restart and nothing records memory or CPU, so "is it leaking?", "why did it restart?" and "which job burns CPU?" cannot be answered afterwards.

**Context.** The report proposes 2,016 rows (7 days), about 300 small writes a day, which it calls trivial. Most sources already exist.

**Investigation.** `process.memoryUsage` appears only in `apps/backend/scripts/remote-bandwidth-baseline.ts`, never under `src`. `handleMetrics` already assembles recurring work, event-loop and console figures (`apps/backend/src/gateway-handlers.ts:350-356`). DB bytes are [0810](#0810-database-observability)'s. Bridge restarts have no counter. Bounded stores with their own guards exist to copy: `compatibility-path-usage` merges once a minute (`compatibility-path-usage.ts`), and `usage-history` prunes by age and count (`usage-history-store.ts:296-323`). Scheduled work runs through `RecurringWorkMetrics`-aware jobs in `core/index.ts`.

**Decisions.**

- **Store?**
  - **A `health-summary` store on `StorageDatabase.rows()`, one row per sample, pruned in the write transaction (recommended; the report's choice).**
    - Pros: queryable; survives restarts; the raw writer guard covers it.
    - Cons: a few more fsynced commits on a busy database; part of every hourly copy until [0760](0760-e5-database-upkeep.md#0760-take-the-change-ledger-out-of-hourly-snapshots).
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

#### 2. Clean shutdown marker

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

### Constraints and rationale

- Rows hold numbers and job kinds only. Recurring-work kinds are already bounded and content-free.
- The sample must not itself be a recurring job that distorts the numbers it reports. Keep it to one timer.

### Needs verification

- Whether `process.memoryUsage` under Bun reports what an RSS leak needs was not run.

## 0810: Database observability

### Task analysis

#### Tasks

1. **Size and retention in `/metrics`**: file, WAL and freelist bytes, backup count and bytes, the last retention report. Status: open.
2. **Lease and transaction waits**: histograms, busy counts and a log line on lease timeout. Status: open.
3. **Top tables**: sampled per-table bytes, off the hot path. Status: open.
4. **Settings → Storage panel**: show it to the user. Status: open (depends on 1 and 3).

#### 1. Size and retention in `/metrics`

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

#### 2. Lease and transaction waits

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

#### 3. Top tables

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

#### 4. Settings → Storage panel

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

### Constraints and rationale

- Metrics stay content-free: table names and sizes only, never keys or paths.
- `/metrics` additions must be additive (`gateway-handlers.ts:349-356` comments follow this).

### Needs verification

- Whether Bun 1.4.4's SQLite (`mise.toml:2`) includes `dbstat` was not checked. The report's aggregates may have used another SQLite.

## 0880: Consolidate metric primitives

### Task analysis

#### Tasks

1. **Write-only metrics**: expose or delete `ProgressiveReadMetrics` and `ArtifactMetrics`. Status: open.
2. **Small inefficiencies**: `PreviewMetrics.shift()` and the `/metrics` compatibility read. Status: open.
3. **Shared primitives**: one bounded series and one histogram. Status: open.

#### 1. Write-only metrics

**Problem.** Two stores do per-event work for data nothing outside tests reads.

**Context.** M3. Artifacts also log the same events through `logArtifactEvent`, so the log line survives and the counters do not.

**Investigation.** `ProgressiveReadMetrics` is written at `native-agent-transcript-projection.ts:1714`, passed around at `:677` and cleared at `:781`; only `native-agent-progressive-metrics.test.ts` and `native-agent-service-progressive.test.ts` read it. `ArtifactMetrics` is incremented across `transcript-artifacts/service-*.ts`, with `snapshot()` at `metrics.ts:75` and no non-test reader in `apps/backend/src`.

**Decisions.**

- **Expose or delete?**
  - **Delete `ArtifactMetrics` counters that duplicate a log event, and put `ProgressiveReadMetrics` behind a diagnostics command (recommended).**
    - Pros: progressive reads have no other record, and tests already rely on the shape; artifact events are already in the log.
    - Cons: a count over a period is lost for artifacts unless logs are saved.
  - **Expose both through one diagnostics command.**
    - Pros: nothing lost; R11's bundle can read them.
    - Cons: keeps per-event work whose value is unproved.

#### 2. Small inefficiencies

**Problem.** A shift per sample, and a synchronous database touch on every `/metrics` GET.

**Context.** M5. Both are small and independent of task 3.

**Investigation.** `apps/backend/src/preview-metrics.ts:53` shifts an array per sample once full. `gateway-handlers.ts:352` and `commands-registry-system.ts:80` call `compatibilityPathUsage.snapshot()`, which is `flush()` (`compatibility-path-usage.ts`), merging through the sink, a transaction in `compatibility-path-usage-store.ts:23`.

**Decisions.**

- **The `/metrics` read?**
  - **Answer from `persisted` plus `pending` in memory, and leave persistence to the existing once-a-minute flush (recommended).**
    - Pros: the merge helper for this already exists in `flush`'s failure branch; a GET costs no I/O.
    - Cons: totals from another backend sharing the directory are up to a minute stale.
  - **Keep it.**
    - Pros: always the durable truth; retiring a compatibility path relies on these counts.
    - Cons: a poll of `/metrics` does write work.

The `shift()` fix has no real choice: a fixed ring of the same size.

#### 3. Shared primitives

**Problem.** Stores use incompatible histograms, so snapshots do not compare.

**Context.** M4 counts five stores. A sixth exists now: `NativeSessionInvalidationMetrics` (`native-session-invalidation-metrics.ts:31`).

**Investigation.** `WebAnnotationMetrics` writes cumulative buckets (`web-annotation-metrics.ts`, the loop in `observe`), `RecurringWorkMetrics` per-bucket counts (`recurring-work-metrics.ts:143-152`), and `PreviewMetrics` sampled values. `GatewayMetricsStore` is at `gateway-support-core.ts:912`. All are reached through their own commands or the gateway.

**Decisions.**

- **Is this worth doing?**
  - **Only when a store needs a real change, porting one at a time (recommended).**
    - Pros: no churn in snapshot-shape tests for its own sake; nothing today suffers from the difference.
    - Cons: inconsistency stays for longer.
  - **Port all at once, as the report proposes.**
    - Pros: one shape, and less code.
    - Cons: web-annotation histograms change meaning from cumulative to per-bucket, which any existing reader must follow.

### Constraints and rationale

- Metrics stay content-free and bounded.
- `/metrics` output is additive; a changed meaning needs a new field name.

## 0780: An "Export diagnostics" bundle

### Task analysis

#### Tasks

1. **Build the bundle on the backend**: one command gathers content-free diagnostics into a local archive. Status: open.
2. **Settings button with a manifest**: show what will be saved first. Status: open (depends on 1).
3. **CLI command and `--fix` reference**: `orkestrator diagnostics export`, named in the fix prompt. Status: open (depends on 1).

#### 1. Build the bundle on the backend

**Problem.** The richest diagnostics are unreachable by users, and a bug report means talking someone through finding files.

**Context.** Since the report, the Bug button and `orkestrator --fix` have grown a shared facts reader (`packages/protocol/src/node/bug-report-facts.ts`), listing log names, sizes and backend descriptor fields, never contents. It does not read metrics. The agent reads the logs directly. The two features differ: a bug report drafts a public issue through an agent, and this is a local file.

**Investigation.** Parts exist: `handleMetrics` (`apps/backend/src/gateway-handlers.ts:337-358`) returns gateway metrics, recurring work, compatibility paths, event-loop and console stats, and `changes_get_diagnostics` (`commands-registry-changes.ts:187`) lists owners and counters. Log sizes come from `get_log_storage_stats`. `/__orkestrator/metrics` has no client UI; the metrics route is `API_PREFIX` plus `/metrics` (`gateway-support-core.ts:195`, `:841`). No export code exists. `tar-stream` is the repo's archive dependency (`package.json:37`), and no zip library is.

**Decisions.**

- **Archive format?**
  - **`.tar.gz` through the existing `tar-stream` (recommended).**
    - Pros: no new dependency; Node gzips it natively.
    - Cons: less friendly than a zip on Windows, which the report's "zip" assumes.
  - **Zip, adding a small dependency.**
    - Pros: opens anywhere with a double click.
    - Cons: a new dependency for one feature.
- **What about the debug log portion?**
  - **Last N MB when saving is on, redacted again with `redactBridgeLogLine`-style rules at export (recommended).**
    - Pros: the report's trade-off names a redaction pass; raw vendor lines are the riskiest content.
    - Cons: export cost on a large log; redaction is not a proof of no content.
  - **Exclude debug logs; rely on the essential log and metrics.**
    - Pros: a very strong content-free claim.
    - Cons: the lines that explain most bugs are missing.
- **Where does the backend read the rest?**
  - **In-process from the same functions `handleMetrics` uses (recommended).**
    - Pros: no gateway or auth path; works standalone.
    - Cons: the snapshot code needs moving behind one function both call.
  - **HTTP to its own `/metrics`.**
    - Pros: guaranteed the same answer as the endpoint.
    - Cons: a loopback call with a credential for no gain.

#### 2. Settings button with a manifest

**Problem.** Users should see what a bundle holds before saving it.

**Context.** The report asks for a manifest preview and no upload, matching "nothing leaves the machine".

**Investigation.** Settings → Debug has **Open log folder** and **Clean up logs** (`GlobalSettings.sections.tsx`, near `:2293`). Native save dialogs already exist in `apps/desktop/electron/native-dialogs.ts`.

**Decisions.** None: a two-step command, plan then write, so the manifest is exactly what is written. Web clients receive it as a download.

#### 3. CLI command and `--fix` reference

**Problem.** Headless hosts need it too, and the fix prompt should say it exists.

**Context.** `packages/cli/src/client/fix.ts` grants the agent read access to the logs directory only (`:56-58`).

**Investigation.** `packages/cli/src/client/argv.ts` has no `diagnostics` command. `docs/architecture/public-cli.md` governs new surface, and AGENTS.md asks for the docs to move with it.

**Decisions.**

- **How does `--fix` use it?**
  - **Mention it in the prompt as something the user can attach, with no automatic run (recommended).**
    - Pros: a user keeps control; no change to what the agent can read.
    - Cons: relies on the agent and user acting on it.
  - **Run it and hand the agent the bundle.**
    - Pros: richer reports by default.
    - Cons: widens what the agent reads before a public issue is drafted.

### Constraints and rationale

- It must reuse the content-free rules; logs and metrics never hold prompts, tokens or file contents.
- Some contents do not exist yet: the essential log ([0750](#0750-an-always-on-essential-event-log)) and DB metrics ([0810](#0810-database-observability)). Build the bundle to include what exists and name the rest in the manifest as absent.
- Effective log policy comes from `resolveLogDetail`; include names and levels only.

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [Proposed user controls](../2026-10-29-logging-and-database-efficiency.md#proposed-user-controls)
- [Application logging](../../architecture/logging.md)
- [Logging and database report, R12](../2026-10-29-logging-and-database-efficiency.md#r12-persist-a-small-rolling-health-summary-m1) and [the metrics findings, M1](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [0741 backend responsiveness under load](../../todo/cross-cutting/0741-backend-responsiveness-under-load.md), which collected process figures by hand
- [Logging and database report, R19](../2026-10-29-logging-and-database-efficiency.md#r19-database-observability-m6-d9) and [the metrics findings, M6](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [E13](0000-index.md#closing-check-of-e13-silent-failures) (`0720`, done), [0780](#0780-an-export-diagnostics-bundle), [0820](#0820-persist-a-small-rolling-health-summary)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1 needs this kind of baseline number.
- [Logging and database report, R13](../2026-10-29-logging-and-database-efficiency.md#r13-consolidate-metric-primitives-m3-m4-m5) and [the metrics findings](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [Logging and database report, R11](../2026-10-29-logging-and-database-efficiency.md#r11-export-diagnostics-bundle-m2-l7) and [the metrics findings, M2](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [Report a bug](../../architecture/bug-report.md)
- [0017 CLI command surface](../../todo/cli-and-slash-commands/0017-cli-command-surface.md), which does not cover this command
- 0740, built in E14: `getContainerServerLog` in `apps/web/src/lib/backend/docker-skills.ts` reads every container server's log and, with `previous`, the run before its last relaunch ([closing check](0000-index.md#closing-check-of-e14-docker-logs)), [0820](#0820-persist-a-small-rolling-health-summary)
