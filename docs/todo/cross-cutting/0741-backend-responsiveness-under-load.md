# Backend stops answering under load or when its log reader stalls

Checked against `main` at `7e3ceb7ce` (2026-10-28); tasks 3 to 5 updated
against `79f3bc97e` (2026-10-29). This is task 3 of
[0734](../coordinator-and-multi-review/0734-codex-orkestrator-mcp-handshake-under-load.md)
("Find what makes the backend's `/mcp` handshake slow"), filed separately
because it reaches beyond the handshake.

On arktech-mini on 2026-10-28 about ten Multi Reviews and several workers ran
at once and the host load average was 100 to 140 (18 logical CPUs). Workers'
`send_message` and `check_inbox` calls timed out from about 02:30Z to 03:15Z,
coordinator mail was delayed by about 7 hours, `launch_multi_review` timed out
for one environment, and from 09:13Z Codex turns failed because the agent MCP
`initialize` and `tools/list` handshake missed its 3 s budget. The backend
(pid 59035, started 02:10:48Z) never restarted.

## Task analysis

Analysed 2026-10-28 against `main` at `7e3ceb7ce`.

### Tasks

1. **Keep the backend serving when its stdout reader stalls**: Bun's console blocks the whole backend once the desktop stops reading its output. Status: done (2026-10-28).
2. **Record event-loop stalls**: nothing in the logs measured the backend's own event loop. Status: done (2026-10-28).
3. **Cut per-request work on the agent MCP endpoint**: every request rebuilt the tool server and parsed the whole mail store. Status: done (2026-10-29). No request parses the mail store any more; building the tool server per request stays, by decision, until task 6 shows it matters.
4. **Find what held the desktop main thread from 02:22:55Z to 09:08:17Z**: Status: done as an investigation (2026-10-29). It was most likely a modal alert opened behind other windows; which dialog is not recorded anywhere. The fixes are in [0880](0880-desktop-main-thread-held-by-modal-dialog.md).
5. **Stop parsing the whole mail store per mail call**: Status: done (2026-10-29). Reads use a shared read model that re-parses only changed rows; writes still parse once.
6. **Qualify under load with the new stall log**: Status: open. Needs a live heavy run; the procedure is in task 6.

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

**Next step.** [0880](0880-desktop-main-thread-held-by-modal-dialog.md):
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

**Goal.** Determine why MCP handshakes or mail calls time out under heavy
load. A timer-lateness log shows that the backend event loop did not run
promptly, with cause unresolved. Backend work, host CPU starvation and
suspension can all delay the timer. No covering stall is inconclusive:
cumulative backend work can exhaust the 15 s budget of 0734 without one
covering timer delay.

**How to run it.** Run it on the production install on a normal working day,
not from an agent worktree: the run *is* the real workload. Collect logs,
metrics, process CPU or profiling data, and host scheduling and sleep/wake
diagnostics.

1. Install a build that contains tasks 1, 2, 3 and 5, and note the backend's
   start time.
2. Start the heavy run: ten or more Multi Reviews at once, plus several
   Coordinator workers, so the load average passes the logical CPU count
   (18 on arktech-mini). Record start and end times in UTC, with `uptime`
   every minute (`while :; do date -u; uptime; sleep 60; done > load.txt`).
3. During and after the run, collect:
   - timestamped backend process CPU samples or a CPU profile, host
     scheduling evidence, and host sleep/wake records; load averages alone
     cannot distinguish backend CPU work from CPU starvation or suspension;
   - stall lines:
     `grep -h "\[Backend\] Event loop stalled" "$HOME/Library/Application Support/orkestrator-v2/logs/orkestrator-ai-$(date -u +%F).log"`;
   - dropped-console markers: `grep -h "\[Backend\] Dropped" <same file>`;
   - the metrics snapshot, from the signed-in desktop or through the
     gateway with the user's own session: `GET /__orkestrator/metrics`, the
     `eventLoop` (tick count, max lag, late-tick buckets, last 20 stalls) and
     `consoleOutput` objects. Never paste the gateway token into logs or
     tickets;
   - Codex handshake failures: `grep -h "timed out handshaking"` over the
     same log, and each failing session's Codex log;
   - mail tool timeouts as workers report them (`send_message`,
     `check_inbox`).
4. Line the times up. For each handshake or mail timeout, look for a
   `stalled for N ms, ending T` line whose window covers it.
   - A covering stall establishes delayed event-loop execution, not its
     cause. Correlate process CPU or profiling data with host scheduling
     and sleep/wake evidence before choosing the design note below or the
     `tools/list` cache. The metrics' last stalls are timer delays, not CPU
     profiles.
   - No covering stall does not exclude backend work or establish a host
     or Codex cause. Examine the same correlated evidence and record the
     load average at that minute. If evidence is missing, leave the cause
     unresolved.
5. Record the evidence here with *measured* and *inferred* labels, and set
   this task's status.

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

### Task 5: writers still take a full mutable copy

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
  [0880](0880-desktop-main-thread-held-by-modal-dialog.md).
- **Why:** the brief asked for logs only, and the logs cannot name the
  dialog. The fixes (logging dialogs, giving every modal a visible parent,
  turning off preview pages' dialogs, a desktop stall log) are separate
  changes that each need a reproduction on macOS.
- **Assumed:** how Electron's macOS message box behaves without a parent
  (`runModal`) comes from Electron's source as remembered. Electron ships
  binaries only, and its docs say nothing about it. 0880 task 5 verifies it.

### Task 6: left open

- **Chose:** describe the run exactly and leave the task open.
- **Why:** it needs a real heavy workload on the production install, and
  this work must not run the backend or the app against the real data
  directory.

### Benchmarks: one shared fixture

- **Chose:** move the synthetic data directory setup into
  `apps/backend/scripts/agent-mail-bench-fixture.ts`, used by
  `agent-mcp-handshake-bench.ts` and the new `agent-mail-store-bench.ts`.
- **Why:** both benches need the same 600-mailbox store. The before and after
  figures above come from interleaved runs on one host, with the original
  sources swapped back in for the "before" runs.
