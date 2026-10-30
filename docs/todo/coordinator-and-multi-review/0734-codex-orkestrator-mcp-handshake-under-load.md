# Codex workflow turns refused when the Orkestrator MCP handshake is slow

Checked against `main` at `a6a3105f9` (2026-10-28); statuses rechecked
against `cd7bbe3e5` (2026-10-30).

On arktech-mini on 2026-10-28, from about 09:13Z, most Multi Reviews failed
on Codex preparation and consolidation turns with
`codex rejected the prompt (HTTP 424): Codex could not offer submit_validation_plan|submit_consolidated_review to this session: the orkestrator MCP server could not list its tools`.
About ten reviews were running at once and the host load average was 100 to
140. One review (env `59847e5f`) got through, so the failure was
intermittent.

## Task analysis

Analysed 2026-10-28 against `main` at `a6a3105f9`. Statuses and task 2
updated 2026-10-30 against `main` at `cd7bbe3e5`.

### Tasks

1. **Give the handshake a budget that survives host load**: raise the Codex `startup_timeout_sec` for the Orkestrator servers and make the bridge's tool check wait past it. Status: done (2026-10-28, #1381).
2. **Qualify under load**: rerun about ten concurrent Multi Reviews with Codex preparation and consolidation on a loaded host. Status: open. The Codex timeout check (2026-10-28) and the backend handshake bench under synthetic CPU load (2026-10-30) are done; the real ten-review run needs billed turns and is still to do (steps in task 2).
3. **Find what makes the backend's `/mcp` handshake slow**: the same backend also timed out agent `send_message` and `check_inbox` calls overnight, and `launch_multi_review` control calls. Status: done (2026-10-29). Investigated in [0741](../cross-cutting/0741-backend-responsiveness-under-load.md); its fixes merged in #1387 and #1423. The heavy-load run that tells backend stalls from host CPU is 0741 task 6, still open.

### 1. Give the handshake a budget that survives host load

**Problem.** Every thread-scoped Orkestrator MCP server had `startup_timeout_sec: 3` (`bridges/codex-bridge/src/engine/app-server-engine.ts`, the `mcp_servers.orkestrator`, `orkestrator-design` and `orkestrator-artifacts` entries). The process-level default had the same value (`bridges/codex-bridge/src/codex-config.ts`). If Codex cannot finish `initialize` and `tools/list` in that time, it marks the server failed for the life of the thread and reports `toolsError`. `classifyMcpToolAvailability` (`bridges/codex-bridge/src/engine/mcp-tool-availability.ts`) treats `toolsError` as a definite "missing". `app-server-runtime-prompt.ts` then answers 424 before the turn starts, and nothing retries.

**Context.** The availability check exists so that a workflow turn without its submit tool fails at once instead of running to the end and making the backend wait minutes (`mcp-tool-availability.ts` header). It polls `mcpServerStatus/list` for up to 5 s and treats `starting` as undecided, so with a 3 s budget a slow handshake always settled as failed inside that 5 s window.

**Investigation.** Evidence from the logs on arktech-mini, read-only:
- The backend (pid 59035) ran from 02:10:48Z and never restarted. It is the process listening on the agent MCP port `127.0.0.1:49248`, so the MCP server did not crash and its port did not change.
- In `~/.codex/logs_2.sqlite`, from 09:50Z on, the orkestrator server repeatedly fails with `MCP server startup failed server_name="orkestrator" error=timed out handshaking with MCP server after 3s`. Next to that are `streamable HTTP post_message failed … endpoint_path="/mcp" mcp_method="initialize"` and `"notifications/initialized"`, then `rmcp::transport::worker … worker quit with fatal: Transport channel closed`. Codex's own retry (`attempt=1 max_attempts=3 delay_ms=250`) ran inside the same 3 s budget.
- The Orkestrator log has no `rmcp::transport::worker` errors on 2026-10-26, three each in the 2026-10-27T02, 2026-10-28T00 and 2026-10-28T02 hours, then 28 in the 09 hour (the first at 09:13:32Z) and 14 in the 10 hour. That growth matches the burst of concurrent reviews. The bridge suppresses the text of those stderr lines (`process-supervisor.ts`, `describeChildStderrLine`). The Codex log database holds no matching rows before 09:50Z, so the 09:13Z to 09:50Z failures are shown only by these counts.
- None of the logs records an auth or token failure.

**Decisions.**

- **How large a budget?**
  - **15 s for every Orkestrator server, thread-scoped and process-level, with the bridge's check waiting 20 s (chosen).**
    - Pros: an idle backend still answers in milliseconds, so a turn waits only while the backend is slow. A slow handshake now ends `connected` instead of failing the thread.
    - Cons: on an overloaded host the first turn of a thread can wait up to 15 s for MCP startup, and a backend that never answers still fails, now after 15 s.
  - **Reload the thread and retry when startup failed.**
    - Pros: recovers even after a failure longer than any fixed budget.
    - Cons: a fresh preparation or consolidation thread has no rollout, so it cannot be resumed and would need a new thread. That is more state handling for the same load symptom.

### 2. Qualify under load

**Controlled live qualification (2026-10-28).** Added
`bridges/codex-bridge/src/app-server/mcp-startup.live.test.ts`, which runs the
pinned Codex 0.164.0 through the real engine against a loopback streamable HTTP
MCP fixture. Ten simultaneous `initialize` requests delay their responses by
4, 10, 14 or 17 seconds. No model turn or real credential is used. The fixture
records monotonic time from receiving `initialize` to receiving `tools/list`;
the engine uses the default 20-second availability wait.

The first passing run measured:

| Delayed initialize | Threads | Measured handshake | Result |
| --- | --- | --- | --- |
| 4 s | 3 | 4.006 s | available |
| 10 s | 3 | 10.003–10.004 s | available |
| 14 s | 2 | 14.003 s | available |
| 17 s | 2 | no tools/list | missing, `could not list its tools` after 14.819 s from receiving initialize |

Codex starts its timeout before the fixture receives `initialize`, explaining
why the failed connection settles slightly under 15 seconds on this clock.
The host had 18 logical CPUs; load averages before the run were
52.52 / 50.68 / 53.95 and after it 61.09 / 52.65 / 54.59.
The helper tests additionally pin 15 and 20 seconds exactly, exercise both
`connected` and `failed` at the startup deadline, and exhaust the full default
window while still starting. The HTTP route tests pass through the real
runtime, engine and helper: no turn or journal record while starting, 424 for
a definite failure, and 202 on connection or expiration with an unverified
listing.

Reproduce and retain content-free measurements:

```sh
RUN_LIVE_CODEX_APP_SERVER=1 \
CODEX_MCP_STARTUP_EVIDENCE_PATH=/tmp/codex-mcp-startup-evidence.json \
mise run test:logged -- --name mcp-startup-live -- \
  bun test ./bridges/codex-bridge/src/app-server/mcp-startup.live.test.ts \
  --preload ./tests/setup-node.ts --parallel=1
```

**Remaining production qualification.** This establishes real Codex timeout
behavior with concurrent delayed HTTP responses on a busy host. It does not
reproduce ten complete Multi Reviews, the production backend's event-loop
saturation, or the original load average of 100–140. That wider operational
qualification remains open; the original handshake duration cannot be inferred
from the old timeout logs.

**Backend handshake under synthetic CPU load (2026-10-30).** The Codex side
is settled above; this measures the backend side on current `main`
(`cd7bbe3e5`, which has #1387 and #1423). It runs
`apps/backend/scripts/agent-mcp-handshake-bench.ts` (todo 0741) on mbp3, which
has 18 logical CPUs, under Bun 1.4.4. The fixture is the 0741 default: 100
environments × 6 tabs and 600 messages of 1.8 KB. Synthetic load is a number
of busy-loop processes ("hogs") at normal priority. Each one exits after 75 or
90 s by itself. The bench started 20 s after the hogs did. Other agents were
working on the host at the same time. The load averages below are therefore
the host's own, not the hogs' alone. The 1-minute average also trails the hog
count. Two runs per figure where there are two:

| Hogs (per logical CPU) | Load avg at bench start | 40-handshake burst, wall | 200-handshake burst, wall | 400-handshake burst, wall | Backend CPU per handshake | Sequential p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 30.1 | 45.9 ms | 171.1 ms | — | 1.8–2.6 ms | 1.2–1.6 / 2.1–2.5 ms |
| 72 (4×) | 64.6, 267.7 | 235.5, 344.0 ms | 1,269, 1,481 ms | 2,984 ms | 2.4–3.4 ms | 2.3–2.5 / 3.7–8.7 ms |
| 126 (7×) | 185.9, 381.5 | 537.5, 500.2 ms | 2,868, 2,816 ms | 4,905 ms | 2.8–3.3 ms | 2.5–2.7 / 4.6–47.8 ms |

The 200-burst at no load ran right after the first 126-hog run had ended.
Its 1-minute load average still read 239 from that run.

- *Measured.* Backend CPU per handshake stays between 1.8 and 3.4 ms
  whatever the load. Load stretches only the wall time. A burst's wall time
  grows linearly with its size: about 6 to 7.5 ms per handshake with 72 hogs,
  and 12 to 14 ms with 126 hogs. The slowest handshake of the largest burst
  (400 at 7× oversubscription) finished in 4.9 s. That is a third of Codex's
  15 s budget.
- *Inferred, assuming the slope stays linear.* At 7× oversubscription about
  1,000 handshakes would have to arrive together before the last one missed
  15 s. Every Codex workflow thread opens at most three Orkestrator servers
  (`orkestrator`, plus `orkestrator-artifacts` and `orkestrator-design` when
  the turn has them). Even if each review starts five Codex threads at once,
  ten reviews make about 150 handshakes, inside the 200-burst measured here.
- *Inferred.* Before 0741, a handshake cost 8.3 to 9.7 ms of backend CPU on
  the same fixture. At the same share of a core, a 200-burst would then have
  taken about 8 s, well past the old 3 s budget. That fits the 2026-10-28
  failures, but it does not prove them.
- *Not covered.* The bench client runs in the same process as the server,
  so it steals CPU from it. This makes the figures pessimistic for the
  handshake itself. The bench does not include the backend's other work
  during a review: bridge streams, SSE, review orchestration, mail sends.
  The live check below covers the Codex side under the same load. A long
  backend stall from that other work would still miss the budget, and only a
  real run with 0741's stall log can show one.

Reproduce (the loop ends its hogs by itself; check `pgrep -f "alarm 90"`
is empty afterwards):

```sh
for hogs in 72 126; do
  for i in $(seq "$hogs"); do perl -e 'alarm 90; 1 while 1' & done
  sleep 20; echo "hogs=$hogs $(uptime)"
  for c in 40 200 400; do
    mise exec -- bun apps/backend/scripts/agent-mcp-handshake-bench.ts \
      --sequential 200 --concurrent "$c"
  done
  wait
done
```

**The Codex check under the same load (2026-10-30).** I reran the 2026-10-28
`mcp-startup.live.test.ts` command above with 126 hogs, 20 s after they
started. It uses Codex 0.164.0, an isolated Codex home and an unreachable
model URL, so no turn is made. The load average was 102.7 before the run and
130.5 after it. *Measured:* it passed in 18.5 s. The delayed handshakes of
4, 10 and 14 s took 4.002, 10.001–10.002 and 14.003 s and were available. The
17 s handshakes settled as missing (`could not list its tools`) after
14.950 s. At 7× oversubscription Codex keeps to its 15 s budget as it did on
an idle host. Its own start-up under load does not eat into that budget.

**Live qualification still to do.** The run needs billed Codex turns and is
not done. Combine it with 0741 task 6. That task uses the same workload and
collects the stall log, which is what separates a backend stall from host CPU
starvation.

1. On the production install, run a build that has #1381, #1387 and #1423
   (v2.34.4-beta or later). Note the backend's start time and the build
   version.
2. Pick ten environments with a branch diff worth reviewing. Make Codex the
   preparation/consolidation model: the Multi Review dialog's
   preparation/consolidation model, or `reviewModel` on
   `launch_multi_review`. Have at least two Codex reviewer rows per review,
   so more Codex threads start together.
3. Get the host load average past its logical CPU count before you launch
   (18 on arktech-mini). Use Coordinator workers, or the hog loop above, with
   `alarm` raised to the length of the run. Log the load every minute:
   `while :; do date -u; uptime; sleep 60; done > load.txt`.
4. Launch all ten reviews within one minute, and record each review's
   environment id and launch time in UTC.
5. When every review has finished, collect the following:
   - Orkestrator log, `~/Library/Application Support/orkestrator-v2/logs/orkestrator-ai-<UTC date>.log`:
     `grep -c "could not list its tools"` (the 424 refusals),
     `grep -h "\[Backend\] Event loop stalled"` and `grep -h "\[Backend\] Dropped"`.
   - The Codex log, read-only, from the Codex home the app's sessions use
     (`~/.codex` unless the session runs under a separate account home):
     `sqlite3 -readonly ~/.codex/logs_2.sqlite "select datetime(ts,'unixepoch'), feedback_log_body from logs where ts >= strftime('%s','<run start, UTC>') and feedback_log_body like '%handshaking with MCP server%'"`.
   - `GET /__orkestrator/metrics` `eventLoop` and `consoleOutput`, as in 0741
     task 6. Do not paste the gateway token anywhere.
   - Each review's outcome: preparation, every reviewer, consolidation.
6. **Pass:** no 424 `could not list its tools` refusal and no
   `timed out handshaking … after 15s`, and every review finished its
   preparation and consolidation. **Fail:** any such line. Line it up
   against the stall lines and `load.txt` as 0741 task 6 describes. A covering
   stall means backend work, so take the `tools/list` cache or 0741's own
   process design. No stall means host CPU or the Codex side.
7. Record the figures here, labelled measured or inferred, and set this
   task's status.

**Decisions.**

- **Is the synthetic bench enough to close task 2?**
  - **Keep the task open until a real ten-review run (recommended).**
    - Pros: the original failure came from a full production run. The bench
      and the live Codex check leave out the backend's other work during real
      reviews, and that is the part that could still stall.
    - Cons: closing waits on billed turns and a heavy run.
  - **Close it on the bench and the live Codex checks.**
    - Pros: both halves of the handshake are measured with wide margins.
    - Cons: it would close on evidence that leaves out what could still
      stall the backend.
- **Run it separately or with 0741 task 6?**
  - **Together (recommended).** Pros: one heavy run, one set of billed
    turns, and the stall log lines up with the handshake failures. Cons: one
    run has to be read for two todos.
  - **Separately.** Pros: each run is simpler. Cons: twice the billed turns
    for the same workload.

### 3. Find what makes the backend's `/mcp` handshake slow

**Problem.** An MCP handshake on localhost taking more than 3 s means the backend's event loop, or the host, was saturated. The longer budget hides that but does not remove it. The overnight agent mail timeouts and the `launch_multi_review` timeouts point the same way.

**Context.** The agent MCP server shares the single backend process (`bun`) with every other client, bridge stream and SSE connection.

**Findings (2026-10-28).** Investigated in
[0741](../cross-cutting/0741-backend-responsiveness-under-load.md). The
overnight mail timeouts were a 6 h 45 min freeze of the whole backend: the
desktop stopped reading its stdout, and Bun's console blocks once that socket
is full. The backend now writes console output without blocking, logs
event-loop stalls, and no longer parses the whole mail store on every `/mcp`
request except `initialize` and `server/discover`. What held the desktop main
thread, and whether the 09:13Z handshake timeouts were backend stalls or host
CPU, stay open there.

**Status (2026-10-30).** Done, checked against `cd7bbe3e5`. The
handshake-related fixes are on `main`: the non-blocking console and the stall
log (#1387, 0741 tasks 1 and 2), and the end of mail-store parsing per `/mcp`
request and per mail call (#1423, 0741 tasks 3 and 5). With 40 concurrent
handshakes, 0741 measured a wall time of 123–152 ms before #1423 and
58–72 ms after it. Task 2's bench shows that the remaining per-handshake cost
holds under synthetic load. 0741 keeps the decision to cache `tools/list`
only if task 6 there shows the backend itself is slow.

## Assumptions and decisions

### Task 1: mark it done without changes

Already on `main`: #1381 (`fb2e51adc`) set
`ORKESTRATOR_MCP_STARTUP_TIMEOUT_SEC = 15`
(`bridges/codex-bridge/src/engine/mcp-tool-availability.ts`). That constant
is used by every Orkestrator server entry in `app-server-engine.ts` and by
the process-level override in `codex-config.ts`. The availability wait is
`MCP_TOOL_AVAILABILITY_TIMEOUT_MS = (15 + 5) * 1_000`. Nothing was redone.

### Task 3: mark it done, with the heavy-load run left in 0741

The investigation and its fixes merged in #1387 and #1423, as listed above.
The one open part, telling backend stalls from host CPU in a heavy run, is
0741 task 6. Leaving task 3 open here as well would track the same run
twice.

### Task 2: measure the backend under synthetic CPU load, not a live run

Done as the task asked: the 0741 handshake bench under busy-loop load at
4× and 7× the logical CPU count, with bursts of 40, 200 and 400 handshakes.
I also reran the existing live Codex startup test under 7× load. It makes no
model turn and uses an isolated Codex home, so it fits the no-billed-turns
constraint and checks the other end of the same handshake.
I did not add a load option to the bench script, because the shell loop in
task 2 reproduces the run and needs no new code. The hogs used
`perl -e 'alarm N; 1 while 1'`, so each exits by itself. I confirmed none was
left afterwards. No backend, app or CLI backend ran against the real data
directory, and the bench binds an ephemeral loopback port of its own.

### Task 2: keep the task open (recommended option)

The bench leaves a wide margin: the slowest handshake took 4.9 s against a
15 s budget, and the largest burst was more than twice the inferred
demand of ten reviews. Codex kept to its 15 s budget at 7× oversubscription. Neither check
covers the backend's other work during real reviews. I took the recommended option in task 2's
decisions: keep the task open and run the real ten-review run together with
0741 task 6. The steps are in task 2. That run needs billed turns, so it is
not done.

### Task 2: no new todo

The remaining live run is task 2 itself and overlaps 0741 task 6, so I did
not create a follow-up todo in 0992–0993.
