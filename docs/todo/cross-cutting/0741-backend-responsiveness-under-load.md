# Backend stops answering under load or when its log reader stalls

## Task analysis

Analysed 2026-11-09 against main at `64a5b4cfb`; tasks 1–5 retain their
2026-10-28/29 investigations and task 6 its 2026-11-06 measurements.

Checked against `main` at `7e3ceb7ce` (2026-10-28); tasks 3 to 5 updated
against `79f3bc97e` (2026-10-29), task 6 against `b0ad3f747` (2026-11-06). This is task 3 of
to-do 0734 (retired 2026-11-10; the Codex handshake budget is in
[agent-engines.md](../../architecture/agent-engines.md#workflow-results-through-tool-calls))
("Find what makes the backend's `/mcp` handshake slow"), filed separately
because it reaches beyond the handshake.

On arktech-mini on 2026-10-28 about ten Multi Reviews and several workers ran
at once and the host load average was 100 to 140 (18 logical CPUs). Workers'
`send_message` and `check_inbox` calls timed out from about 02:30Z to 03:15Z,
coordinator mail was delayed by about 7 hours, `launch_multi_review` timed out
for one environment, and from 09:13Z Codex turns failed because the agent MCP
`initialize` and `tools/list` handshake missed its 3 s budget. The backend
(pid 59035, started 02:10:48Z) never restarted.

### Tasks

1. **Keep the backend serving when its stdout reader stalls**: Bun's console blocks the whole backend once the desktop stops reading its output. Status: done (2026-10-28).
2. **Record event-loop stalls**: nothing in the logs measured the backend's own event loop. Status: done (2026-10-28).
3. **Cut per-request work on the agent MCP endpoint**: every request rebuilt the tool server and parsed the whole mail store. Status: done (2026-10-29). No request parses the mail store any more; building the tool server per request stays, by decision, until task 6 shows it matters.
4. **Find what held the desktop main thread from 02:22:55Z to 09:08:17Z**: Status: done as an investigation (2026-10-29). It was most likely a modal alert opened behind other windows; which dialog is not recorded anywhere. The fixes were made under 0880 (deleted 2026-11-06); its live check moved to 7568 (0741 task 7).
5. **Stop parsing the whole mail store per mail call**: Status: done (2026-10-29). Reads use a shared read model that re-parses only changed rows; task 8 extends it to writes.
6. **Qualify under load with the new stall log**: Part A, the ledger at production scale, ran 2026-11-06. Four statements that read whole tables for about 1 to 24 s with a cold cache are fixed, and on a quiet disk a run at mini's size had no stall over 1 s. The 2026-11-06 FULL-mode run stalled for 10 to 15 s under disk contention. Ledger-only `synchronous = NORMAL` and 30-day retention were agreed and implemented on 2026-11-09 ([5821 task 3](5821-ledger-retention-live-evidence.md#task-3-ledger-durability-and-archive-window)); the earlier measurements and decision options below are historical. Part B, the live heavy run on the production install, moved to the manual-test checklist; what is left here is reading its evidence (steps 5 and 6 below) and choosing whether the design note or a `tools/list` cache is needed. Status: blocked (waits on 7568: 0741 task 6).
8. **Reuse revision-validated mail rows in writes**: send, acknowledge, seen and deletion no longer parse unchanged store rows. Status: done (2026-11-09); before/after measurements below.

Evidence is labelled **measured** (read from logs, the power log, the unified
log, or a benchmark run) or **inferred** (a conclusion the measurements fit
but do not prove).

### 1. Keep the backend serving when its stdout reader stalls

**Problem.** For 6 h 45 min the backend did not answer anything, then resumed
all at once.

**Investigation.**

- *Measured, Orkestrator log (read-only).* `orkestrator-ai-2026-10-28.log` has
  no lines at all from 02:22:55.916Z to 09:08:17.932Z. The first line after the
  gap is the desktop updater's `Checking for update`, then a 137-line burst
  stamped 09:08:18.006Z and about 209 KB in the first second. That burst
  contains backend lines whose own embedded times (`connectedAt` of SSE
  connections) run from 02:23:01.603Z to 02:25:20.315Z. The next embedded time
  is 09:08:25.982Z. The backend produced no output between 02:25:20Z and
  09:08:18Z, and the lines it wrote just before had been waiting in the
  socket.
- *Measured, process table.* The backend's stdout and stderr are Unix sockets
  to the desktop main process (`lsof -p 59035`), read by `readline` in
  `apps/desktop/electron/backend-process.ts`.
- *Measured, isolated experiment (Bun 1.4.4, Node 22 parent, then Bun parent in
  the committed test).* A child that logs steadily and serves HTTP, whose
  parent pauses reading stdout:

  | Child writes with | HTTP probe while paused | Worst timer lateness |
  | --- | --- | --- |
  | `console.log` | timed out after 3 s | 7,147 ms |
  | `Bun.write(Bun.stdout, …)` | timed out after 3 s | 7,160 ms |
  | `process.stdout.write` | answered in 50 ms | 8 ms |
  | `fs.write(1, …)` (one in flight) | answered in 51 ms | 11 ms |

  `process.stdout.write` never blocks, but queues without bound (its
  `writableLength` stays 0 in Bun); its callback fires once the bytes reach the
  socket. `process.exit` discards what is still queued (87 KB of 1 MB arrived).
- *Measured, power log (`pmset -g log`).* The desktop process (pid 58998)
  created a `NoIdleSleepAssertion "Playing audio"` at 02:22:55Z and released it
  at 09:08:19Z after 06:45:24, the same window to the second.
- *Measured, unified log (`log show`, pid 58998).* At 02:22:56Z the desktop
  process opened `com.apple.iconservices`. At 09:08:17.912Z AppKit logged a
  mouse-up button action on the main thread; the updater line followed 20 ms
  later.
- *Measured.* The updater checks every 6 hours (00:35, 06:35, 12:35 on
  2026-10-27). After the 02:11:20Z check, the next ran at 09:08:17Z, not
  08:11Z: the desktop's own timers did not run during the gap.

**Conclusion.** *Inferred:* the desktop main thread was held from 02:22:55Z
to 09:08:17Z, most likely by a native alert (sound, icon, and released by a
click), and stopped reading the backend's stdout. *Measured:* a stalled reader
blocks a Bun process on its next `console` write. *Inferred:* the backend
froze at about 02:25:20Z when the socket filled, which explains the mail
timeouts that started around 02:30Z, the 7-hour mail delay (mail was
dispatched at 09:08:18Z) and the stalled bridges, whose own stdout the frozen
backend stopped draining.

**Decisions.**

- **How to write console output?**
  - **Bounded, non-blocking console in the backend (chosen).**
    `apps/backend/src/bounded-console.ts` replaces `console.log`/`info`/`debug`
    (stdout) and `warn`/`error` (stderr) with `process.stdout.write` and its
    callback. It counts unflushed bytes per stream and starts dropping lines
    once 4 MiB is pending. It keeps dropping until the backlog falls to 2 MiB,
    then writes one `[Backend] Dropped N log line(s) (B bytes) from <start> to <end>`
    line and resumes. The marker does not wait for an empty backlog, which a
    steadily logging process may never reach (the first version of the
    integration test caught this). A line is always written when nothing is
    pending. `main.ts` installs it
    first, and the exit path waits up to 2 s for pending output, because
    `process.exit` would discard it.
    - Pros: the backend keeps serving whatever the reader does; memory is
      bounded; the gap is visible in the log with its times.
    - Cons: lines are lost during a stall (counted, not recovered). Formatting
      now goes through `util.formatWithOptions`, so a logged object prints on
      one line where Bun's console printed it over several.
  - **Write the backend's own log file under Electron too.**
    - Pros: no loss while the desktop is stalled.
    - Cons: every line is recorded twice, and retention and rotation have to
      be shared with the desktop log. Left as a possible follow-up; the
      bounded console is needed either way, because stdout still exists.
  - **Fix only the desktop.** Not enough: any reader that stops (a debugger,
    a suspended terminal, a future supervisor) would freeze the backend again.

### 2. Record event-loop stalls

**Problem.** No log or metric measured the backend's event loop, so the
09:13Z handshake timeouts cannot be attributed. Log-write delay (desktop
write time minus the backend's embedded `connectedAt`) peaks at about 1.1 s
between 09:10Z and 10:10Z (measured). That figure mixes in the socket and the
desktop's own loop, so it is not a measure of the backend's loop.

**Decisions.**

- **How to measure?**
  - **A timer-lateness sampler (chosen).** `packages/protocol/src/event-loop-stall-monitor.ts`
    chains a 500 ms timer. A tick at least 1 s late logs
    `[Backend] Event loop stalled for N ms, ending <time>`. Lines are at most
    one per 30 s, with suppressed stalls folded into the next line, and a
    stall of 10 s or more is always logged. `/__orkestrator/metrics` gains
    `eventLoop` (tick count, max lag, late-tick buckets at 100 ms, 1 s, 5 s,
    30 s, the last 20 stalls) and `consoleOutput` (the bounded console's
    pending, written and dropped counters).
    - Pros: one timer callback per 500 ms; sees blocking synchronous work.
    - Cons: a sleeping host is reported as a stall too.
  - **`perf_hooks.monitorEventLoopDelay`.** Rejected: in Bun it reported about
    1 ms for a 50 ms synchronous block (todo 0050, `scripts/efficiency/resources.ts`).

### 3. Cut per-request work on the agent MCP endpoint

**Problem.** `/mcp` is stateless. Every request (each `initialize`,
`tools/list` and `tools/call`) builds a new `McpServer`, registers every tool
with fresh Zod schemas, loads the config, and calls `listAgentMailboxes`.
That call parses every row of the agent mail store, all mailboxes with their
messages, only to write the caller's mailbox address into the server's
`instructions`. The SDK sends `instructions` only in the `initialize` and
`server/discover` results.

**Investigation.**

- *Measured, real database (read-only, sizes only).* The `agent-mail` store
  had 600 rows totalling 1,224 KiB at 12:45Z.
- *Measured, `apps/backend/scripts/agent-mcp-handshake-bench.ts`.* Synthetic
  data directory with 100 environments × 6 tabs and 600 messages of 1.8 KB.
  Host load average 55 to 65 on 18 CPUs. Each figure is two runs, before →
  after the change below:

  | | Before | After |
  | --- | --- | --- |
  | Sequential handshake p50 | 21.5, 22.0 ms | 12.4, 15.4 ms |
  | 40 concurrent handshakes, wall | 493, 699 ms | 325, 348 ms |
  | Backend CPU per handshake | 8.3, 9.7 ms | 6.5, 6.2 ms |
  | One `listAgentMailboxes` | 5.7–8.6 ms | (unchanged) |

- *Measured, CPU profile.* With an empty mail store, a warm handshake costs
  about 2.3 ms of CPU, and Zod schema construction (`zod/v4/core` `init`) is
  about 30 % of the profile.
- *Inferred.* At a load average of 100 to 140 on 18 CPUs, the backend's thread
  gets well under one core. A burst of handshakes from about ten reviews
  starting at once, queued behind other backend work, can exceed 3 s. The
  per-request cost scales with the size of the mail store.

**Decisions.**

- **Look up mailboxes only when the answer carries instructions (done).**
  `agentMcpAnnounces` checks the parsed body for `initialize` or
  `server/discover`. Any other body skips the lookup, and an unrecognised
  shape keeps the old behaviour. Tested over both protocol eras in
  `agent-tools.test.ts`.
- **Cache the tool server or its `tools/list` result per scope (not done).**
  Hoisting the Zod schemas to module level, or caching the server per
  credential, would remove most of the remaining cost. It touches every tool
  registration module, and the measured remaining cost (about 2 ms warm) does
  not justify it before task 6 shows the handshake is still slow.
- **Move agent MCP to its own worker or process (not done).** See the design
  note below. Not justified by these measurements: the freeze in task 1 was
  not CPU work, and the handshake's own cost is a few milliseconds.

**Follow-up (2026-10-29).** Task 5's read model also serves the mailbox
lookup `initialize` still makes.

- *Measured, the same bench, before → after task 5.* Interleaved runs on one
  host at a load average of 12 to 14, two runs each:

  | | Before | After |
  | --- | --- | --- |
  | Sequential handshake p50 | 2.9, 4.5 ms | 2.5, 3.5 ms |
  | 40 concurrent handshakes, wall | 152, 123 ms | 72, 58 ms |
  | Backend CPU per handshake | 5.9, 5.2 ms | 2.6, 2.4 ms |
  | One `listAgentMailboxes` | 2.4, 1.7 ms | 0.1, 0.2 ms |

- *Measured, CPU profile of the bench (1,500 sequential handshakes).* What
  remains is the per-request tool server: `createAgentToolServer` is about
  16 % of the samples, and the SDK converting Zod input schemas to JSON
  Schema for `tools/list` (`convertListedInputSchema`) about 11.5 %. Neither
  touches storage.

The decision above stands (see **Assumptions and decisions**): caching the
`tools/list` result is the next step if task 6 shows the backend itself is
slow.

### 4. Find what held the desktop main thread from 02:22:55Z to 09:08:17Z

**Problem.** Task 1 keeps the backend serving, but the desktop window, its IPC
and the remote clients it relays still freeze for as long as the main thread
is held.

**Context.** `apps/desktop/electron/restart-prompt.ts` records the same
symptom on Linux with `dialog.showErrorBox`. The desktop shows windowless
`dialog.showMessageBox(options)` in `showNonBlockingError` and the toolchain
prompt (`main.ts`), and in the updater prompts when no window is focused
(`auto-update.ts`). Renderer `window.confirm` calls (`AgentInfoButton.tsx`)
are user-initiated.

**Investigation (2026-10-29, logs read only).**

- *Measured, Orkestrator log.* The desktop's own last line before the gap is
  the updater's 02:11:21Z `Update for version 2.34.1-beta is not available`,
  after the 02:10:42Z relaunch that installed 2.34.1-beta for a remote
  request. Nothing between then and 09:08:17Z names a dialog, a prompt, an
  error or the updater. Every main-process dialog path that logs first stayed
  silent: `[Desktop] Local backend exited unexpectedly` before
  `showNonBlockingError`, the local-start and startup failures, and
  electron-updater's `Checking for update` before a check. The
  update-ready prompt needs a downloaded update, and there was none.
- *Measured, Orkestrator log after the gap.* At 09:08:18.013Z about 100
  `Error occurred in handler for 'orkestrator:invoke': [TypeError: fetch failed]`
  lines arrive within 6 ms, then `[Updater] Could not report to the backend: fetch failed`.
  These are renderer IPC calls that queued while the main thread was held and
  failed at once against the frozen backend.
- *Measured, unified log (`/usr/bin/log show`).*
  - 02:22:38.371Z: WindowServer drops the app's `AppDrawing` assertion, so
    its window had stopped drawing.
  - 02:22:55.741Z: powerd takes the app's power assertion. This is the power
    log's `"Playing audio"`.
  - 02:22:56.173Z: WindowServer logs
    `CPS: Denying OrkestratorV2 the right to be in front because it is not in the list of permittedFrontASNs`.
    The app asked to become the active app and macOS refused.
  - 09:08:03Z: the app becomes frontmost because someone switched to it.
    WindowServer gives it keyboard focus at 09:08:07Z, and it resumes about
    10 s later.
  - At neither edge do `tccd`, `SecurityAgent` or `UserNotificationCenter`
    log anything, so this was not a privacy or keychain prompt.
- *Measured, code.* The renderer's notification sounds play through an
  `AudioContext` (`apps/web/src/lib/notification-sounds.ts`). Browser preview
  views set `safeDialogs: true` but not `disableDialogs`
  (`browser-preview-manager.ts`), so a previewed page's `alert`, `confirm`,
  `prompt` and `beforeunload` open native dialogs. Artifact hosts set
  `disableDialogs: true`.

**Conclusion.**

- *Inferred:* the sound was a renderer notification sound. Chromium's
  browser process holds a `"Playing audio"` power-save blocker while a page is
  audible and releases it on the UI thread. The release waited until
  09:08:19Z, so the main thread stopped running tasks within about a second
  of 02:22:55.7Z.
- *Inferred:* the main thread ran a nested AppKit modal loop rather than
  blocking in a call. It took focus and handled the final click, but
  Chromium tasks and Node did not run in it: the 6-hourly update check
  missed 08:11Z, stdout went unread and the audio blocker stayed.
- *Inferred:* the app asking to come to the front 0.4 s after the sound fits
  an app-modal alert opening. macOS refused the activation, so the alert
  stayed behind other windows until someone switched to the app.
- *Inferred, not verified in this checkout:* Electron's macOS message box
  uses `runModal` when it has no parent window, or a parent that is not
  visible, such as a minimized window. With a visible parent it is a sheet
  that does not block. Electron's own docs do not say. The same code shows
  web pages' JavaScript dialogs, with the page's owner window as parent.
- By elimination, the likeliest source is a JavaScript dialog from web
  contents (a browser preview page, or Electron's own print or auth
  dialogs) while the window was not drawing. A windowless main-process dialog
  with no log line is the other possibility. Nothing logs dialogs, so the
  logs cannot name it.

**Next step.** 0880 (deleted 2026-11-06; its live check is 7568, 0741 task 7):
log every dialog, never open a modal without a visible parent, disable or
reroute preview pages' dialogs, add a main-thread stall log to the desktop,
and reproduce in a disposable profile.

### 5. Stop parsing the whole mail store per mail call

**Problem.** `AgentMailStore.load` assembled every mailbox and message
(`assembleStoredValue` → `JSON.parse` per row) on each `send_message`,
`check_inbox`, presence sweep and, before task 3, every MCP request. The store
is 1.2 MiB today and may grow to its 32 MiB limit.

**Investigation.**

- *Measured, `apps/backend/scripts/agent-mail-store-bench.ts`.* Same
  synthetic data as task 3 (100 environments × 6 tabs, 600 messages of 1.8 KB).
  CPU milliseconds per call, three interleaved before/after runs at a load
  average of 16 to 18:

  | Call (what uses it) | Before | After |
  | --- | --- | --- |
  | Pull-tab lookup (every mail tool call) | 1.66, 1.76, 1.41 | 0.03, 0.04, 0.04 |
  | Directory (`send_message`, `initialize`) | 1.84, 1.93, 1.70 | 0.27, 0.32, 0.16 |
  | Inbox (`check_inbox`) | 1.92, 1.79, 1.49 | 0.17, 0.22, 0.11 |
  | Message status | 1.54, 1.70, 1.53 | 0.02, 0.03, 0.02 |
  | Pending injects (inject sweep) | 1.83, 1.86, 1.60 | 0.16, 0.31, 0.11 |
  | UI summary | 1.88, 2.04, 1.70 | 0.44, 0.59, 0.38 |
  | Send | 8.86, 9.37, 8.84 | 6.50, 7.79, 5.45 |
  | Send, then acknowledge | 16.46, 17.53, 15.66 | 10.53, 14.85, 10.91 |
  | Inbox read right after a send | 12.58, 14.80, 13.22 | 7.44, 9.11, 6.69 |

- *Measured, a send split by phase (after the read model, before the size
  check change).* Of 6.2 ms: the writer's `load` 1.3 ms, the size check that
  pretty-printed the whole store 1.55 ms, the row diff and commit 1.55 ms,
  the replay check's `snapshot` 0.7 ms.
- *Measured, micro-benchmark of 1,200 rows (1.6 MB).* `JSON.parse` of every
  row 1.6 ms, pretty `JSON.stringify` of the store 2.6 ms, `JSON.stringify`
  of every row 1.5 ms, `structuredClone` of every parsed row 14.7 ms.

**Change.**

- `AgentMailStore.snapshot()` returns one shared, deeply frozen store that
  is kept between calls and rebuilt only when the store's committed revision
  moves, which any writer in any process bumps. A rebuild reads the
  serialized rows from the connection's revision-validated cache
  (`StorageDatabase.readStoreSerialized`, `StorageContext.loadStoreSerialized`)
  and parses only rows whose serialized value changed. Every read-only path
  uses it: the pull-tab lookups, directory, inboxes, batch reads, summary,
  inbox snapshot, status, sent lists, conversations, pending and interrupted
  injects, the budget-hold notice, the hourly-release pre-check, and the
  idempotent-replay check of `sendAgentMail`. A store buffered by
  `atomically`, one stored whole, or one with an unreadable row reads through
  `load` as before.
- The 32 MiB limit is checked against the serialized rows the save writes
  anyway (`maxBytes` on `saveSensitiveJson`, `StoreTooLargeError`), not by
  pretty-printing the store a second time.
- Tests: `storage-agent-mail-read-model.test.ts` (snapshot equals `load`
  across send, ack, seen and delete; frozen and shared; only changed rows
  are parsed; another connection's write is seen; an unreadable row reads as
  `load` reads it) and `storage-database.test.ts` (`maxBytes`,
  `readStoreSerialized`).

### 6. Qualify under load with the new stall log

**Problem.** Under heavy agent load, MCP handshakes and mail calls time out,
and on 2026-11-05 the backend stopped running its event loop for up to 48.7 s
at a time. A timer-lateness line shows that the loop did not run promptly; it
does not say why. Backend work, host CPU starvation and suspension can all
delay the timer. No covering stall is inconclusive: cumulative backend work
can exhaust the 15 s budget of 0734 without one covering timer delay. Part A
asks whether the change-tracking ledger's own work can hold the loop for
seconds at production size. Part B is the live qualification on the
production install.

**Context.**

- *Measured by the coordinator from arktech-mini's logs (read only), not
  re-read for this task: stall history.* The worst stalls came
  before the fixes, on v2.36.3, while the ledger was still inside
  `orkestrator.sqlite`. From 12:35Z to 12:45Z on 2026-11-05 there were stalls of
  13 to 30 s every 40 to 60 s, then 5 backend restarts. From 17:00Z to 18:59Z
  there were 177 stalls, the longest 48.7 s, and about 226 loopback
  `connect ECONNRESET` errors from the desktop. Logged stall lines per day:

  | Day | Lines |
  | --- | --- |
  | 10-30 | 4 |
  | 10-31 | 9 |
  | 11-01 | 9 |
  | 11-02 | 15 |
  | 11-03 | 18 |
  | 11-04 | 23 |
  | 11-05 | about 190 (about 460 with folded repeats) |
  | 11-06 | 181, all before 07:01Z |

  There have been none since 07:01Z on 11-06, on v2.36.5 and v2.36.6.
- *Measured by the coordinator, the same way: what the stalls lined up with.* Agent activity: an hour with no
  prompts had no stalls. Not gateway bursts, and not the number of bridges.
  Five `usage.source-stalled scope=disk kind=timeout` lines fell inside stall
  hours. The desktop process on the same host never stalled.
- *Measured by the coordinator, the same way: the ledger on 2026-11-06.* `change-tracking.sqlite`, 1.26 GB and
  about 2.8M rows after about two weeks: `change_measurement_files` 482 MB,
  `change_measurements` 159 MB, `change_frames` 107 MB plus a 96 MB unique
  index, `change_evidence` 91 MB. It opens through `StorageDatabase`
  (`ledger-schema.ts`), so every statement runs synchronously on the event
  loop, with `synchronous = FULL`, `secure_delete = ON` and a 10 s busy
  timeout.
- Already ruled out as current causes: in-process upkeep (fixed by #1939) and
  the free-page drain (finished).

**Investigation, part A: the ledger at production scale (2026-11-06, done).**

`scripts/efficiency/ledger-scale.ts` (method in
[efficiency-harness.md](../../development/efficiency-harness.md#ledger-at-production-scale))
built a synthetic ledger of 2,813,402 rows and 1.28 GB in a temporary
directory on arktech-mini, with row shapes copied from real rows: 360
environments, 1,080 conversations, 8,640 turns, 80,640 measurements with
1.31M file rows. It
ran the real `ChangeTrackingService` on it under 8 agent loops (tool, turn and
turn-diff evidence through `pullEvidence`, 300-file environment scans), with
reads, hourly passes and purges of three environments. No real ledger or data
directory was opened, nothing was bound, and no provider was called. Host load
average 3 to 14 during the runs.

- *Measured, worst event-loop stall per operation, before → after the fix.*
  Lateness of a 2 ms timer chain; 20 s phases; the after column is the final
  code (`after-run2`):

  | Operation | Before | After |
  | --- | --- | --- |
  | Evidence ingestion and commits (8 agents) | 278 ms, 87 stalls ≥ 100 ms, 124 turns | 155 ms, 1 stall ≥ 100 ms, 752 turns |
  | Measurement queries (views, presentations, history, file pages) | 8 ms | 7 ms |
  | Hourly retention pass with three purges | **1,378 ms** | 72 ms |
  | Manifest JSON: 100,000-entry capture manifest (12.5 MB), serialize / store / cold read | 180 / 5 / 14 ms | 172 / 6 / 14 ms |
  | Measurement JSON parse, 1,000 reads | 4 ms | 1 ms |
  | All of the above together | 276 ms, 86 stalls ≥ 100 ms | 134 ms, 1 stall ≥ 100 ms |
  | 7-day window: first passes retire the 773,000 rows past it | 177 ms | 120 ms |

  With the fix, on a quiet disk, no ledger operation stalled for 1 s or more.
  Before it, every hourly pass did. The longest single transaction after the fix was 155 ms
  (one frame's ingestion). The serialize figure is a capture's own
  `JSON.stringify`, not a ledger statement.
- *Measured, the statements behind it.* Each was timed on a fresh APFS clone of
  the synthetic ledger (cold page cache), then again warm:

  | Statement (caller) | Plan | Cold | Warm |
  | --- | --- | --- | --- |
  | Superseded-measurement candidates over every owner (`pruneSupersededMeasurements` without an owner, from the hourly pass) | `SCAN change_measurements USING INDEX change_measurements_owner`, a table read per row for `id`, `SCAN change_selections` | **23,990 ms** | 155 ms |
  | Provider turn diffs past the window (`retireExpiredProviderTurns`, every pass) | `SEARCH change_evidence USING INDEX change_evidence_owner (owner_kind=?)`, a table read per provider-turn row | **3,268 ms** | 18 ms |
  | Open tool windows (`allOpenWindows`: every pass's sweep, startup reconciliation, diagnostics) | `SCAN change_tool_windows` | **1,229 ms** | 17 ms |
  | A purged binding's provider turns (`retireBinding`, per binding) | `SEARCH change_evidence USING INDEX change_evidence_owner (owner_kind=?)` | 965 ms | 15 ms |
  | One owner's prune candidates (every publication that supersedes) | `LIST SUBQUERY` over `SCAN change_selections` | not timed cold | 51 ms (worst in a run) |

  The global query also ran once per batch of 64 measurements: a backlog of
  superseded measurements meant one whole-table query per batch, with only a
  zero-length yield between them. Statements over smaller tables stayed under
  1 s cold: `snapshotAges` 203 ms, `finishPurge`'s outbox sweep 127 ms,
  `worktreeUsedElsewhere` 104 ms, `referencedSnapshotIds` 72 ms,
  `retireEmptyBindings` 71 ms.
- *Measured, after the fix.* A full walk of the owner index is 155 pages of
  512 owners, worst page 2.2 ms cold and 0.6 ms warm. A provider-turn page by
  row id is 3 ms cold, the open windows 0.0 ms, a binding's provider turns
  0.1 ms. Building the three new indexes on the 2.8M-row ledger took 326,
  883 and 976 ms, once.
- *Measured, commits under disk contention (after the fix).* The figures
  above were taken on a quiet disk (all runs ended by 22:32Z). A second run of
  the fixed code with `--disk-writers 2` (22:37Z to 22:41Z) overlapped another
  worktree's benchmark, which ran four more fsync-loop writers from 22:33Z. So
  it ran against six writers, a load this task did not control:

  | Phase | Worst stall | Stalls ≥ 1 s | Longest transaction |
  | --- | --- | --- | --- |
  | Evidence ingestion and commits | 10,391 ms | 6 | 10,281 ms (`publish`) |
  | Hourly retention pass with three purges | 14,729 ms | 17 | 14,730 ms (a retirement batch); `PRAGMA incremental_vacuum(128)` 6,672 ms |
  | All together | 10,373 ms | 6 | 10,259 ms (`afterIngest`) |

  No statement inside those transactions took more than 8 ms. The time is the
  commit: with `synchronous = FULL` every commit fsyncs the WAL on the event
  loop. A loop of one-row ledger commits on a fresh file measured p50 12 ms and
  worst 2,598 ms with `FULL`, against p50 0.0 ms and worst 761 ms with
  `NORMAL`, while another project's integration tests drove the disk at 340
  to 990 MB/s. A second sample under the six writers gave `FULL` worst 352 ms
  and `NORMAL` worst 934 ms; the worst case varies with what else writes. An
  agent turn makes about 30 ledger commits (6,000 frame ingestions, 5,400
  publications and 4,800 post-ingest transactions over 600 turns in
  `after-run1`), so under contention they also add up.
- *Inferred, the link to 2026-11-05.* A cold or partly cold page cache is
  likely on a host running ten reviews and Docker. A pass draining a backlog
  of superseded measurements then runs one 1 to 24 s query per batch, back to
  back. That fits the 13 to 30 s stalls and their repetition, and the link
  to agent activity, because publications create the superseded
  measurements. Commit fsyncs under disk contention fit as well, and better
  for the longest stalls: they reached 10 to 15 s here even with the scans
  fixed, they grow with agent activity, and the five
  `usage.source-stalled scope=disk kind=timeout` lines fell inside stall
  hours. Neither is proven as the cause: the real ledger's backlog on
  11-05 was not measured, and v2.36.3 also held the ledger in the main
  database. Why the stalls stopped at 07:01Z on 11-06 is not explained by
  this run. A drained backlog and a warm cache would fit, but neither was
  observed.

**Change (part A).**

- The hourly pass finds superseded measurements with
  `ChangeLedger.supersededOwnersPage`. It reads 512 owners at a time from the
  covering owner index, yields between pages, and prunes each owner with more
  than it keeps through its own index range. `pruneSupersededMeasurements`
  now always takes an owner.
- A pruning candidate's selection is checked with `NOT EXISTS` through
  `change_selections_measurement`, not an `IN` list built from every
  selection.
- `retireExpiredProviderTurns` walks evidence in row order (ingestion order)
  a page at a time, as operations already were, and stops at the first row
  inside the window. A pass with nothing expired reads one row.
- Two partial indexes: `change_tool_windows_open_only` (open windows only) and
  `change_evidence_provider_turn_frames` (provider-turn evidence by frame key,
  named in the purge query with `INDEXED BY`). All three new indexes are
  created by `LedgerRetirement.ensureIndexes`, now also at service start before
  reconciliation, without a schema version.
- `ledger-scan-plans.test.ts` records every statement that a publication, a
  pull, two passes and a purge prepare. It plans each one on a fresh ledger
  and fails on any that walks a large table. Against the old code it names
  exactly the five statements above. It also covers the owner walk and the
  provider-turn walk.

**Investigation, part B: the production heavy run.** The run itself (install,
heavy load, collecting stall lines, metrics, CPU and host evidence, and the
optional stack sample) is human-only and moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md) (0741
task 6) on 2026-11-10. When its evidence arrives:

5. Line the times up. For each handshake or mail timeout, look for a
   `stalled for N ms, ending T` line whose window covers it.
   - A covering stall establishes delayed event-loop execution, not its
     cause. Correlate process CPU or profiling data with host scheduling
     and sleep and wake evidence before choosing the design note below or the
     `tools/list` cache. The metrics' last stalls are timer delays, not CPU
     profiles.
   - No covering stall does not exclude backend work or establish a host or
     Codex cause. Examine the same correlated evidence and record the load
     average at that minute. If evidence is missing, leave the cause
     unresolved.
6. Record the evidence here with *measured* and *inferred* labels, and set
   this task's status.

**Decisions.**

- **How to keep ledger statements off whole tables?**
  - **Indexes and paged walks in the ledger, with a plan test (chosen, recommended).**
    - Pros: every periodic statement is now a seek or a bounded page (cold
      worst 2 to 3 ms). Small diff. An older build still opens the file.
      The plan test catches the next scan before it ships.
    - Cons: three more indexes to keep up on writes, a few MB; a one-time
      build at first start.
  - **Move the ledger to a worker thread or a child process.**
    - Pros: no ledger statement can stall the loop, whatever its plan.
    - Cons: every ledger call becomes asynchronous across a message port, and
      transactions span the ingestion and publication paths. A large
      refactor, and the scans would still cost seconds of disk reads.
  - **A covering index for the old window query only.**
    - Pros: one line.
    - Cons: still a whole-index scan per batch, and it leaves the other three
      statements.
- **Bound the ledger's size or retention?** At about 90 MB a day,
  `archivedBodyRetentionDays` (90) lets the ledger reach about 8 GB before
  anything ages out. Part A shows that size is no longer a stall source:
  shortening the window to 7 days retired 773,000 rows with a worst stall of
  120 ms.
  - **Lower the window to 30 days (recommended).**
    - Pros: one policy value (`policy-registry.ts`). The ledger levels off at
      about 2.7 GB at mini's rate. The first pass after the change retires the
      backlog in bounded batches (measured above).
    - Cons: user-visible: turn diffs and tool measurements older than 30 days
      answer `history-expired`. In the synthetic model, about three quarters of
      the file rows belong to live environment and Git-scope views, which age does not
      remove (inferred for mini, since the real share was not measured).
  - **Keep 90 days.**
    - Pros: no user-visible change; stall-safe after part A.
    - Cons: an 8 GB ledger; more disk, longer backups, and cold reads of a
      larger file.
  - **A size budget that retires the oldest finished work first.**
    - Pros: bounds the file directly, whatever the rate.
    - Cons: new pressure logic beside the snapshot quota; history depth then
      depends on activity.

  Not implemented: the window is a retention promise to the user, so the
  user decides. To-do
  [5821](5821-ledger-retention-live-evidence.md) tasks 1 and 3 measure the
  real table sizes and a real first run.
- **How to keep commit fsyncs off the event loop?** Not decided here: it
  changes the ledger's durability contract, and another worktree
  (`storage-release-vs-writers`, with a script not on `main` at the time) was
  measuring `synchronous = NORMAL` against disk writers at the same time, so
  the two results should be read together. That worktree's result
  ([7210](7210-storage-work-left-on-the-event-loop.md) task 4) does not
  settle this one. For the free-page release child, `NORMAL` changed nothing
  under four fsync writers (worst backend write 3.3 s and 3.4 s, against
  1.5–4.2 s with `FULL`). Its long write-lock holds were cold page reads,
  not commit fsyncs. A ledger commit is a small write with no such reads, and
  there the measured `NORMAL` p50 was 0.0 ms, so the difference is specific to
  ledger commits. Open: the user decides.
  - **`synchronous = NORMAL` for the ledger file only (recommended).**
    - Pros: one setting in `openChangeLedgerDatabase`. A commit no longer
      fsyncs (p50 0.0 ms against 12 ms under contention). WAL mode keeps the
      file consistent, and a process crash loses nothing.
    - Cons: a power loss or an OS crash can lose the last commits, including
      evidence frames already acknowledged to a bridge, which then drops them.
      That breaks "every accepted frame is durable before it is acknowledged"
      in `evidence-ingestion.ts`, so the contract and its documentation change
      with it. WAL checkpoints still fsync on the loop (worst 761 to 934 ms
      measured).
  - **Fewer commits: one transaction per pull, not per frame and body.**
    - Pros: keeps full durability; cuts the number of fsyncs per turn several
      times.
    - Cons: one fsync under contention still took 2.6 to 10 s, so it lowers
      how often the loop stalls, not how long. Bodies must be fetched before
      the transaction, which restructures ingestion.
  - **Run the ledger's connection on a worker thread.**
    - Pros: no ledger commit or statement can hold the event loop, durability
      unchanged.
    - Cons: every ledger call becomes asynchronous across a message port; a
      large refactor of a synchronous API used by ingestion, publication,
      projection and retention.
- **When to build the new indexes?**
  - **At service start, before reconciliation (chosen, recommended).**
    - Pros: before the backend serves agent traffic; startup reconciliation
      already scanned every tool window on every start, so this replaces a
      recurring scan with a one-time build.
    - Cons: on a ledger of mini's size the first start after the upgrade holds
      the loop for about 2.2 s, once, and the stall log may record it.
  - **In the first retention pass.**
    - Pros: no startup cost.
    - Cons: the same 2.2 s, during working hours, and the publication path
      would run without its selection index until then.
  - **In a child process.**
    - Pros: no stall at all.
    - Cons: a second writer on the ledger file during startup, for a one-time
      cost.

### 8. Reuse revision-validated mail rows in writes

**Problem.** Task 5 left each mail mutation parsing every row through `load`,
even when changing only one mailbox. The bounded store can reach 32 MiB.

**Context.** `AgentMailStore.snapshot()` already validates committed database
revisions and reuses parsed rows with identical serialized values. The existing
lease and complete-value save are shared by all mail writers, including atomic
buffering and legacy document-mode recovery.

**Investigation.** Implemented on mini, 2026-11-09. `load()` copies the shared
read model using a JSON-data copy routine; it no longer reparses unchanged rows.
A private uncached load remains for document/atomic-buffer/corruption fallbacks,
so those paths do not recurse into the read model. Save format, row ordering,
idempotency and the UTF-8 32 MiB limit are unchanged. Tests spy on parsing across
send, acknowledge, seen and delete, verify abandoned copies cannot mutate the
committed view, and retain the existing external-writer and atomic tests.

Measured with `mise exec -- bun apps/backend/scripts/agent-mail-store-bench.ts
--iterations 100`: 100 environments × 6 tabs, 600 synthetic 1.8 KB messages.
Two interleaved before/after runs on the same host, wall / CPU ms per call:

| Operation | Before, run 1 | After, run 1 | Before, run 2 | After, run 2 |
| --- | --- | --- | --- | --- |
| Send | 2.95 / 3.10 | 2.22 / 2.42 | 2.98 / 3.17 | 2.27 / 2.52 |
| Send then acknowledge | 5.90 / 6.21 | 4.67 / 4.95 | 5.93 / 6.24 | 4.80 / 5.04 |
| Inbox after send | 3.47 / 3.92 | 2.81 / 3.11 | 3.47 / 3.93 | 2.82 / 3.12 |

The before variant restored only `load()`'s original whole-store path; the after
variant used the final copy routine. Initial unpaired measurements varied with
host load, so the paired results above are the comparison. A preliminary
`structuredClone` version regressed send to 5.20 ms and was replaced.

**Decisions.**

- **Reuse the read model and copy its JSON data (recommended; implemented).**
  - Pros: parses only changed rows; preserves all writers, leases, atomic buffering and storage limits; measured lower call cost.
  - Cons: still copies and serializes the store for a write; this is not a constant-time row mutation.
- **Convert every mail writer to targeted row mutations.**
  - Pros: could also avoid whole-store copying/serialization.
  - Cons: a larger refactor of the shared writer and invariants than required to remove reparsing.

## Design note: agent MCP in its own process

If task 6 shows long stalls caused by unrelated backend work, serve `/mcp`
from a Bun `Worker` or a child process. It would hold the credential maps and
forward tool calls that need storage to the main thread over a message port.
`initialize`, `tools/list` and the instructions (from a cached mailbox
directory pushed by the main thread) would then answer even while the main
loop is busy. Mail and Kanban tool calls would still wait for the main thread
because storage is single-owner, so this helps handshakes, not mail
latency. Adopt the added IPC surface only when correlated process CPU or
profiling data and host scheduling or sleep evidence establish unrelated
backend work as the bottleneck.

## Assumptions and decisions

No decision in this file was marked **(recommended)**. Where a task had a
**Next step**, that was taken as the recommendation. Each choice below says
where the work followed it and where the findings argued against it.

### Task 6: separate timer delay from its cause

Aligned this procedure with 0734: a covering timer delay establishes late
event-loop execution, while process CPU or profiling data and host
scheduling or sleep evidence are required to attribute it. No covering
stall is inconclusive, so task 6 remains open pending live evidence.

### Task 5: a revision-keyed read model, not per-mailbox row reads

- **Chose:** the in-memory read model described in task 5, instead of the
  Next step's "read single mailboxes by row".
- **Why:** most mail reads need every mailbox, not one:
  - the directory counts every mailbox's unread mail;
  - status, the sent lists and the inject sweep scan all messages;
  - the pull-tab lookup filters all mailboxes by environment.

  Row reads would have helped only the inbox read. The read model makes every
  read cost the rows that changed since the last one. The database already
  caches each store's serialized rows by committed revision, so the model
  reuses those strings and needs no second copy. Revisions are never reused,
  and every write bumps one, including other processes' writes and
  `StorageDatabase.rows()`. So a snapshot is never older than a `load` made
  at the same moment.

### Task 5: share one frozen snapshot rather than hand out copies

- **Chose:** freeze the snapshot deeply and share it, so that mutating it
  throws `TypeError` instead of corrupting later reads. The two paths that
  return a whole stored message (`getAgentMailMessage` and the idempotent
  replay in `sendAgentMail`) return a `structuredClone` of it.
- **Why:** a copy per read would cost more than the parse it replaces:
  `structuredClone` measured about 9 times slower than `JSON.parse` for the
  same rows. Summaries are shallow copies that share their frozen `from` and
  `notice` objects; no caller writes to those.

### Task 8: copy the revision-validated read model for writes

Chose the recommended read-model reuse rather than changing every writer's
storage API. Mutable copies retain isolation from frozen snapshots and failed
writes. A JSON-only copy avoids `structuredClone`'s measured overhead; changed
rows are still reparsed once to refresh the canonical committed model. The
interleaved benchmark above measures the resulting end-to-end calls.

### Task 5: writers still take a full mutable copy (superseded by task 8)

- **Chose:** keep `load()` for the roughly 30 read-modify-write paths.
- **Why:** parsing is the cheapest way to get a mutable copy. Writing only
  the changed rows would mean moving every mail writer to
  `updateStoreRow`, because a store may have only one kind of writer
  (`docs/architecture/storage.md`). That is a larger refactor than this task.
  A send still costs about 5 to 8 ms of CPU at 1.6 MB, down from about 9.

### Task 5: measure the 32 MiB limit on the stored rows

- **Chose:** check `AGENT_MAIL_MAX_STORE_BYTES` against the UTF-8 size of the
  compact JSON the save writes (envelope document and rows), and drop the
  separate pretty-printed `JSON.stringify` of the whole store.
- **Why:** that stringify was 1.55 ms of a 6.2 ms send. The limit was defined
  when the store was one pretty-printed file. The rows are what is stored
  now. The new measure is smaller for the same content, so the limit allows
  somewhat more mail, and it is still a fixed bound.
  `docs/architecture/agent-messaging.md` says so.

### Task 5: memory held by the read model

- **Assumed:** keeping the parsed store is acceptable. *Inferred:* a few MB
  at today's 1.2 MiB, and a few times the store's size at the 32 MiB limit.
  The serialized strings are the database cache's own and are not copied.
  The model holds one store and is replaced on each rebuild.

### Task 3: keep the `initialize`-only lookup and do not cache the tool server

- **Chose:** keep `agentMcpAnnounces` and leave the per-request tool server
  as it is. This follows the decision already recorded in task 3.
- **Why:** the mailbox lookup now costs about 0.1 ms, and a whole handshake
  about 2.5 ms of CPU. The rest is building the tool server and the SDK's
  JSON Schema conversion. Caching `tools/list` per scope means checking that
  every tool registration module describes its tools the same way for every
  caller, and nothing measured yet shows the handshake's own cost causing a
  timeout. Task 6 decides.

### Task 4: investigation only, fixes in a new todo

- **Chose:** read the Orkestrator log, the unified log and the code, change
  no desktop code, and file the fixes as
  0880.
- **Why:** the brief asked for logs only, and the logs cannot name the
  dialog. The fixes (logging dialogs, giving every modal a visible parent,
  turning off preview pages' dialogs, a desktop stall log) are separate
  changes that each need a reproduction on macOS.
- **Assumed:** how Electron's macOS message box behaves without a parent
  (`runModal`) comes from Electron's source as remembered. Electron ships
  binaries only, and its docs say nothing about it. 0880 task 5 verifies it.

### Task 6: part A on a synthetic ledger, part B left open

- **Chose:** measure the ledger with `scripts/efficiency/ledger-scale.ts` on a
  synthetic copy of mini's size, and leave the live run (part B) open.
- **Why:** the brief forbids opening mini's ledger or running the backend
  against the real data directory, and part B needs the real workload.
  The synthetic rows copy real row shapes and mini's table sizes, but
  their mix (how many live environments, how many superseded measurements) is
  assumed, not measured.

### Task 6: one script beside the counters harness, not a new workload

- **Chose:** a separate script in `scripts/efficiency/`, documented in
  `efficiency-harness.md`, rather than a lettered workload.
- **Why:** the harness repeats each case seven times and compares exact
  counters; a 1.28 GB build takes a minute and stall figures are
  machine-specific, so they would make every baseline run slow and add
  nothing `--compare` could use.

### Task 6: cold figures from the first read of a fresh clone

- **Assumed:** the first statement on a freshly cloned file is a cold read.
  A second clone of the same, recently read ledger answered warm, so later
  clones appear to share the page cache on APFS. The bench's phase figures are
  therefore warm, and the cold column comes from the first queries on the
  first clone. No cache was purged (`purge` needs root).

### Task 6: the window recommended, not changed

- **Chose:** recommend 30 days and leave `archivedBodyRetentionDays` at 90.
- **Why:** it is a one-line change and the bench shows it is stall-safe, but
  it removes history users can open today. The brief allows a bound only if
  it is small and safe, and safe includes not deleting what a user expects to
  keep without asking.

### Task 6: commit fsyncs measured, not changed

- **Chose:** record the contention figures and the options, and change no
  durability setting.
- **Why:** every option either weakens the "durable before acknowledged"
  contract or is a large refactor; the user decides the first, and a review
  should see the second planned. The contention run overlapped another
  worktree's four disk writers, which this task did not start and did not
  stop; the figures are reported with that load named, and the run was not
  repeated so as not to disturb that benchmark again.

### Task 6: `pruneSupersededMeasurements` always takes an owner

- **Chose:** make `owner` required and move the every-owner case to
  `supersededOwnersPage` in the retention pass.
- **Why:** an optional owner left the whole-table form callable. Its one other
  caller was a test, which now names the owner it seeds.

### Benchmarks: one shared fixture

- **Chose:** move the synthetic data directory setup into
  `apps/backend/scripts/agent-mail-bench-fixture.ts`, used by
  `agent-mcp-handshake-bench.ts` and the new `agent-mail-store-bench.ts`.
- **Why:** both benches need the same 600-mailbox store. The before and after
  figures above come from interleaved runs on one host, with the original
  sources swapped back in for the "before" runs.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the part B production heavy run of task 6, and task 7) moved there on 2026-11-10.
