# Backend stops answering under load or when its log reader stalls

Checked against `main` at `7e3ceb7ce` (2026-10-28). This is task 3 of todo
0734 ("Find what makes the backend's `/mcp` handshake slow"), which lives in
`coordinator-and-multi-review/0734-codex-orkestrator-mcp-handshake-under-load.md`
on the branch of PR #1381. It is filed separately so the two branches do not
conflict; 0734's task 3 should point here once both have merged.

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
3. **Cut per-request work on the agent MCP endpoint**: every request rebuilt the tool server and parsed the whole mail store. Status: partly done (2026-10-28).
4. **Find what held the desktop main thread from 02:22:55Z to 09:08:17Z**: Status: open.
5. **Stop parsing the whole mail store per mail call**: Status: open.
6. **Qualify under load with the new stall log**: Status: open.

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
  - **A timer-lateness sampler (chosen).** `apps/backend/src/event-loop-stall-monitor.ts`
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

### 4. Find what held the desktop main thread from 02:22:55Z to 09:08:17Z

**Problem.** Task 1 keeps the backend serving, but the desktop window, its IPC
and the remote clients it relays still freeze for as long as the main thread
is held.

**Context.** `apps/desktop/electron/restart-prompt.ts` records the same
symptom on Linux with `dialog.showErrorBox`. The desktop shows windowless
`dialog.showMessageBox(options)` in `showNonBlockingError` and the toolchain
prompt (`main.ts`), and in the updater prompts when no window is focused
(`auto-update.ts`). No desktop log line before 02:22:55Z names a dialog, so
which one it was is not known. Renderer `window.confirm` calls
(`AgentInfoButton.tsx`) are user-initiated.

**Next step.** Check whether a windowless `showMessageBox` on macOS runs an
app-modal loop that stops Node's event loop, and log every dialog before it
opens. Then either attach every dialog to a window or move it off the main
thread's modal loop.

### 5. Stop parsing the whole mail store per mail call

**Problem.** `AgentMailStore.load` assembles every mailbox and message
(`assembleStoredValue` → `JSON.parse` per row) on each `send_message`,
`check_inbox`, presence sweep and, before task 3, every MCP request. The store
is 1.2 MiB today and may grow to its 32 MiB limit.

**Next step.** Read single mailboxes by row (the store is an envelope layout
whose `mailboxes` collection is one row per mailbox) for the directory, inbox
and status reads. Measure with the bench above first.

### 6. Qualify under load with the new stall log

**Next step.** On the next heavy run (ten Multi Reviews or more), collect
`[Backend] Event loop stalled` lines and `/__orkestrator/metrics` `eventLoop`
and compare their times with Codex `timed out handshaking` rows. A stall
longer than the 15 s budget of 0734 means backend work. A handshake timeout
without one points at host CPU or the Codex side.

## Design note: agent MCP in its own process

If task 6 shows long stalls caused by unrelated backend work, serve `/mcp`
from a Bun `Worker` or a child process. It would hold the credential maps and
forward tool calls that need storage to the main thread over a message port.
`initialize`, `tools/list` and the instructions (from a cached mailbox
directory pushed by the main thread) would then answer even while the main
loop is busy. Mail and Kanban tool calls would still wait for the main thread
because storage is single-owner, so this helps handshakes, not mail
latency. It is not worth the added IPC surface until a stall log shows the
main loop, not the host, is the bottleneck.
