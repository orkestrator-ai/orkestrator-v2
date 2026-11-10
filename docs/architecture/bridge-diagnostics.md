# Bridge debug logging

Status: Living — shared bridge debug logging.

At the default level (`info`) every bridge writes the lifecycle of each turn or
process scope and snapshots for stalls, plus a keepalive every ten minutes. A
healthy turn writes nothing else, however much it changes.
[When a snapshot is written](#when-a-snapshot-is-written) has the rules. For a
snapshot every minute, as before, set `bridge` or `bridge.diagnostics` to Debug or
Trace in **Settings → Debug → Log Detail**, or the default level to either. It
applies to running local and Docker bridges at once, turns already running
included, with no restart. To keep what they write, turn on **Save Logs to Disk**
too; that also applies at once. [logging.md](logging.md#live-settings) covers both
controls and how the setting reaches a bridge.

The backend also passes `ORKESTRATOR_BRIDGE_DEBUG=1` or `0` to every new local and
Docker bridge, as its startup default for the per-minute stream until the setting
arrives. Standalone bridges accept the same variable. The per-bridge spellings
(`CLAUDE_BRIDGE_DEBUG` and the like) are no longer read. Only `1` enables the
stream. The flag never silences lifecycle or stall snapshots: `bridge.diagnostics=warn` does that.

## When a snapshot is written

Each open scope has one timer. Once a minute it looks at the scope and decides
whether to write. It is unreferenced, so it never keeps a process alive, and closing
the scope clears it. Change snapshots (trace only) are the one kind not written by
a look; they need no timer.

| Kind | Event | Written | Detail it needs |
| --- | --- | --- | --- |
| Lifecycle | `send-started`, `send-resolved`, `cancel-requested`, `cancel-settled`, `closed`, `snapshot-overflow` | At the boundary, as before. | `info` |
| Stall | `heartbeat` | At the first look where a stall signal starts or clears, another tool crosses the pending threshold, or any timer firing reaches the late-timer threshold; and, while the no-delta signal holds, at a look where the scope changed (see Changes). | `info` |
| Keepalive | `heartbeat` | When ten minutes (`BRIDGE_DIAGNOSTICS_KEEPALIVE_MS`) have passed since the scope's last snapshot of any kind. | `info` |
| Per-minute | `heartbeat` | At every look, changed or not. This is the stream as it was before, unchanged. | `debug` (or `trace`) |
| Change | `change` | As soon as the phase, the set of pending tools, or a counter by at least its threshold changes, compared with the last snapshot written. Not tied to a look. | `trace` |

So at `info` a healthy turn writes its lifecycle and the keepalive, and nothing
else: the phase moving, tools coming and going and counters climbing are what a
healthy turn does. At `debug` every look is written, so every change is in the
minute stream anyway. At `trace` a change is also written the moment it happens,
on top of the minute stream, which is the only level where a change on its own
produces a snapshot.

Every entry is still written at `info`, so `bridge.diagnostics=warn` silences them
all and a text line looks the same whatever made it. The decision is made at each
look (or, for a change, at each change) from the level in force then, so changing
`bridge.diagnostics` mid-turn applies to a turn already running, in both directions.

**Stall signals.** Each comes from fields the snapshot already carries.

| Signal | Holds when | Threshold | Why |
| --- | --- | --- | --- |
| No delta | The scope is waiting (a turn in `sending`, `following`, `draining` or `cancelling`; a process scope only while a request is pending) and nothing has moved for the threshold: `lastDeltaAgoMs`, or the time since the turn started or the request was sent if no delta came since. | `STALL_NO_DELTA_MS`, 2 minutes | One quiet minute can be a model pause. Two quiet snapshots were the earliest the per-minute stream told a stall from a pause. |
| Tool pending | One entry in `pendingTools` has been pending for the threshold, even while deltas still arrive. | `STALL_TOOL_PENDING_MS`, 10 minutes | The app's own stall warning (Multi Review, the build pipeline) is ten minutes. A pending tool alone is weaker evidence than silence: builds and subagents run long, and unmatched starts are common ([cursor-diagnostics.md](cursor-diagnostics.md)). A tool that is pending *and* silent trips the no-delta signal first. |
| Late timer | `tickDelayMs` reaches the threshold. | `STALL_TICK_DELAY_MS`, 10 seconds | The event-loop monitor's threshold for a stall that is always logged at `error`. |

**Changes.** A scope is compared with the last snapshot written, of any kind, and
has changed when one of these differs:

- the phase (for example `following` to `draining` when the terminal settles, a
  process scope becoming `attached`, or `cancelling`);
- the set of pending tools: a tool that appeared, finished or was replaced;
- a counter, by at least its threshold in `COUNTER_CHANGE_THRESHOLDS`: one timeout,
  protocol error, request sent or response received, or 4 KiB of stderr.
  `notificationsReceived` never counts: notifications are the delta stream itself
  (every ACP `session/update`), and their silence is what the no-delta signal watches.

Ages growing, deltas arriving and the other counters (`deltaCount`, `completedTools`
and so on) moving are never changes.

At `info` a change is written only while the no-delta signal holds: a silent turn
whose tools, phase or error counters still move is evidence of where it is stuck,
and it is written at the next look (at most one a minute). Outside a silent stall a
change is not written at `info`, whatever it is.

At `trace` every change is written as a `change` snapshot when it happens. The
bridge's callback only notes that something moved; the comparison and the write run
once the producer's synchronous work has finished (a microtask, not a timer), so a
burst of updates is one snapshot, a tool replaced by another is one snapshot, and a
tool that starts and finishes in the same burst changes nothing and writes nothing.
An unchanged scope writes no `change`. Below `trace` the callback does one level
check and queues nothing, and builds no arguments. A `change` carries `tickDelayMs: 0`
and does not move the timer's own reference, so the next look's delay is unaffected.

A persistent no-delta or tool-pending stall is written when it starts and again when
it clears. In between, it is written again only for a change during a silent stall
as above. An unchanged stall is not repeated: its ages are what the last snapshot
implies plus the time since. Every qualifying late timer firing is written
independently, including consecutive late firings: its delay describes that firing
and cannot be inferred from an earlier snapshot. Process scopes retain their identity
across cancellation, so an idle process without a pending request does not acquire a
no-delta stall.

Only a successful snapshot write (including an overflow record) advances the
comparison baseline. A failed write is retried at the next qualifying look.

**Reading a gap.** At `info`, a scope that wrote `send-started` and then nothing
is either healthy or its diagnostic timer has died. The keepalive bounds that: no
snapshot for more than ten minutes (plus one look) from an open scope means the
timer is not running. Any snapshot followed by nothing (before the keepalive) means
no stall signal started or cleared at any look since and no timer firing was late.
It says nothing about what the turn did meanwhile: its phase, tools and counters may
have changed freely, and only the next snapshot (a keepalive, a stall or `closed`)
shows where they ended up. For that history, use `debug` (each minute) or `trace`
(each change).

**Restoring the per-minute stream.** Set `bridge.diagnostics=debug` (or `bridge`, or
the default level) in Log Detail, or `ORKESTRATOR_LOG_LEVEL=bridge.diagnostics=debug`
for a bridge started by hand. A config saved with **Save Logs to Disk** on before
the logging split is upgraded to `bridge: debug` ([logging.md](logging.md#live-settings)),
so it keeps the per-minute stream with no change.

## Turning detail on during a turn

Every scope opens whether or not detail is on, and counts from the start. So turning
the per-minute stream on writes one `event=heartbeat` snapshot straight away,
covering the turn so far, and then one a minute. Keeping the scopes open costs a few
counters and a sha256 per tool call on every turn, plus one unreferenced timer. No
arguments are built for a snapshot while `bridge.diagnostics` is below `info`.

| Bridge | A running turn or process | Gap |
| --- | --- | --- |
| Claude | The turn's scope reports at once, with its pending tools and clocks. `debugLog` sites and HTTP summaries start from the change. | Debug events before the change were never recorded. |
| Codex | The process scope reports at once. | None for this scope. Codex has no per-turn scope, on or off. |
| Cursor | The turn's public scope reports at once, with its pending tools and clocks. The SDK seam installs at that moment, and stays installed. | A transport already running is adopted at its next frame, so a completely silent one is not seen. A local execution already in progress is not seen; only later ones are. `transportAttempts` and frame counts start from the change. |
| Pi | The turn's scope reports at once, with its pending tools and approvals. | None. |
| ACP/Grok | The process scope reports at once, with its counters and pending requests. | None. |

A bridge's other log lines (`bridge.claude`, `bridge.codex`, `bridge.cursor`,
`bridge.pi`, `bridge.acp`) are on the same logger and read their level per call, so on
every bridge a level change applies to the next line, in a running turn as anywhere
else. A line skipped while its level was off is not written later.

Event-stream failures are written by default. On the Claude and Codex bridges a
keepalive that cannot be written is `sse.keepalive-failed` at `warn`, and the
Claude connection closes. Codex logs the failure and keeps the stream open so later
frames can still flow. The Claude bridge's `sse.write-failed` and `sse.handshake-failed`
are `warn` too. Routine
connection churn on the Claude bridge (`sse.subscribe-requested`, `sse.opened`,
`sse.aborted`, `sse.cleanup`) is `debug`, so `bridge.claude=debug` shows each client
coming and going.

A bridge without the route (an older container image) keeps its startup setting until
its next start.

Search for `[bridge-diagnostics]`. These are `bridge.diagnostics` entries on the
[shared logger](logging.md), written at `info`, so `ORKESTRATOR_LOG_LEVEL` can also
narrow them (`bridge.diagnostics=warn` silences every one, the per-minute stream
included). In the text log a line is:

```text
[bridge-diagnostics] heartbeat source=claude:env-1 bridge=claude payload="{\"bridge\":\"claude\",\"event\":\"heartbeat\",...}"
```

`payload` is the snapshot as JSON, one string field because nested JSON is not a
logger field. The `bridge` field identifies `claude`, `codex`, `cursor`, `pi`, or
`acp` (Grok), and `source` names the local bridge process and environment. Local
output keeps its level across [the bridge hop](logging.md#the-bridge-hop) and uses
the existing application log sink and its rotation and retention. Docker output goes
to the existing `/tmp/<provider>-bridge.log` files (`/tmp/grok-acp-bridge.log` for
Grok), as JSON lines. A relaunch keeps the run before it
([container-lifecycle.md](container-lifecycle.md#the-previous-run)).

## Desktop startup failures

The application log also records `[DesktopStartup]` events, written by the shared
logger's `desktop.startup` area and unchanged in text. `checking` followed
by `ready` means the renderer reached the desktop IPC bridge and, for Local,
completed a backend configuration read before mounting the workspace. A late
preload or rejected read is retried serially within a ten-second deadline; a
hung request is not duplicated. Failure shows a reload screen before any Docker
checks or project loading, so an unavailable desktop connection cannot appear
as a Docker outage or an empty project list.

- `bridge-unavailable`: the preload API or connection-list IPC did not answer.
- `backend-unavailable`: IPC answered and Local was expected to be available,
  but its backend read did not complete successfully. A Local backend already
  marked unavailable is a mountable degraded state so the existing recovery
  banner and connection settings remain reachable.
- `preload-failed`: Electron rejected the preload; `reason` classifies missing
  modules, permissions, module format, syntax, or an unknown failure.
- `page-load-failed`: Chromium failed the main document load; `code` is its
  numeric network error code.
- `renderer-load-failed`: importing or mounting the application failed; the full
  error remains available in the renderer DevTools console but is not persisted.
- `renderer-error` and `unhandled-rejection`: an uncaught error occurred while
  the renderer was still starting. Recoverable React errors and later runtime
  errors do not emit startup markers.
- `renderer-gone`: the renderer process exited.

Remote windows still allow their connection settings to open if the remote
host is offline. Reloading the recovery screen reloads only that window; it
neither restarts the backend nor cancels background environments.

Only exact, allowlisted console markers from the main frame and bounded lifecycle
metadata enter the desktop log. Raw renderer console output, subframe messages,
error messages, stacks, URLs, paths and backend responses are not forwarded.
Duplicate events are suppressed per main-frame navigation, with a maximum of 32
records per navigation. The existing Save Logs to Disk and retention settings
apply. In the JSON log format (`ORKESTRATOR_LOG_FORMAT=json`) the same events are
records with `"area":"desktop.startup"` and the event name, such as `ready`.

## Shared implementation

`packages/protocol/src/node/bridge-diagnostics.ts` owns flag interpretation, periodic
snapshots, correlation ID hashing, metadata filtering, pending-operation bounds,
event batching and the handover to the logger. Bridge adapters describe their own events;
they do not own logging timers or copy the privacy and size policies.
`src/node/bridge-log-policy.ts` is the route every bridge shares.

Each scope writes its lifecycle boundaries, and periodic snapshots as
[When a snapshot is written](#when-a-snapshot-is-written) describes.
SDK callbacks only update bounded counters. A scope belongs to the bridge turn
or process; renderer unmounts, missed SSE events and inactive environments do
not stop it. These diagnostic heartbeats describe the bridge, not the health
of its network connection to the provider.

| Bridge | Scope and evidence |
| --- | --- |
| Cursor | Turn dispatch, partial/started/completed tools, nested activity, SDK stream versus transcript callback progress, terminal/stream waits and cancellation. |
| Claude | Turn startup, SDK message counts, tool-use/result envelopes, cancellation and iterator closure. Legacy debug sites are aggregated by an allowlisted source label. HTTP summaries include status and duration, never request URLs. |
| Pi | Prompt preflight, SDK events, tool start/end, pending approvals, terminal state and abort progress. |
| ACP/Grok | Child process, pending RPCs with age and method category, received frames, request/response counters, timeouts, protocol errors and suppressed stderr byte counts. |
| Codex | Process health sampled without touching session liveness: generation, restarts, circuit state, RPC counters, pending requests and notification queue depth/high-water mark. |

## Reading a stall snapshot

- `phase=sending`: dispatch/preflight has not returned its accepted handle.
- `phase=following`, `terminal=pending`: waiting for the provider to finish.
- `phase=draining`, `terminal=resolved`, `stream=pending`: a terminal result
  arrived but Cursor's stream has not closed.
- `phase=attached`: a process-wide observer (ACP or Codex), not a turn waiting
  to complete. Read its transport counters and `metrics` instead.
- `lastDeltaAgoMs` versus `lastStreamAgoMs`: interaction callback progress
  versus raw stream progress, where exposed. `null` means unobserved or not
  applicable. Codex exposes cumulative transport counters in `metrics`.
- `pendingTools`: up to eight pending operations, their first-seen age, category,
  nested flag and stage. A provider's tool-use event does not prove an OS
  process exists. Cursor distinguishes partial arguments from explicit starts.
- `untrackedTools`: observations omitted due to the 128-operation tracking cap
  or an oversized/missing identifier; the summary is incomplete when nonzero.
- `cancellation`: whether the SDK cancellation call returned; a returned cancel
  alone does not prove the run has terminated. External cancellation signals
  are also recorded with `event=cancel-requested`.
- `tickDelayMs`: delay beyond the diagnostic interval, which can indicate a
  blocked event loop or a suspended machine.

Turn/process closure stops its diagnostic timer. Metadata logging does not
change retries, timeout budgets, approval decisions or cancellation semantics.

## Cursor SDK boundary snapshots

Cursor also emits `event=sdk-snapshot` alongside the public snapshot, correlated by
the same hashed `session` and `run`, while the per-minute stream is on
(`bridge.diagnostics` at debug), with the gap the table above gives. At the default
level a Cursor stall snapshot has no SDK companion, because the SDK seam installs
only when the stream is turned on.

`coverage=installed` means the pinned SDK's Bun diagnostic seam was installed.
`coverage=unavailable` means the extra observations are missing, not that the
network or executor is idle. The patch targets the Bun export used by desktop
and Docker bridges; a manually launched Node runtime has only the original
public SDK diagnostics. Zero observed transports likewise means no transport
has been observed in this turn, rather than proof of a healthy connection.

The snapshot separates these boundaries:

| Evidence | Interpretation |
| --- | --- |
| Increasing `lastInboundAgoMs` and `serverHeartbeatAgoMs` | No incoming SDK transport traffic observed. |
| Fresh server heartbeats, increasing `lastMeaningfulAgoMs` | The connection is receiving heartbeats without other messages progressing. This clock excludes heartbeats independently of the SDK's own stall clock. |
| `pendingExecutions[].stage=executing` | Cursor's local execution iterator was entered and is waiting for its next response. The category identifies read, shell, MCP, request-context, etc.; arguments are never logged. |
| `stage=response-ready` with increasing `stageAgeMs` | The executor yielded a response, but the SDK loop has not advanced past sending it to the client stream. |
| A recent `completed` execution, no further meaningful incoming messages | The local execution loop completed its writes; further progress is waiting elsewhere. This does not prove the remote service consumed the response. |
| `handlers[].state=errored` | The named SDK controller failed. Raw vendor errors are deliberately excluded. |
| `paused=true` | Cursor paused its stall detector, including while awaiting certain human interaction queries. |
| Public `terminal=resolved`, `stream=pending` | The terminal result arrived, but public stream drainage is still waiting. |

Each transport includes last inbound/outbound frame categories, client/server
heartbeat ages, frame counts, abort/end/dispose flags, and the SDK's internal
controller states and durations. A `started` controller normally spans a whole
stream; its age alone does not mean a tool is stuck. `transportAttempts` and
per-transport attempt numbers distinguish new attempts within the same run.
Transport callbacks only update counters; no log writes run per frame.

Tracking is bounded to 16 transports and 128 simultaneous executions per turn.
Snapshots show four transports, eight pending executions, and the eight most
recent settled executions. Dropped observation counts and total counts expose
incomplete coverage. Transport objects are held weakly; argument/response
payloads are never retained by the diagnostic records. Each snapshot is capped at
8 KiB, with an explicit overflow record if necessary. Closing a bridge turn
releases its observations even if the SDK fails to close; renderer unmounts do
not close the scope.

This identifies the blocked boundary rather than promising visibility into
Cursor's remote service internals. Match the SDK snapshot to the public turn
snapshot before attributing a stall to a filesystem operation or network wait.

## Privacy and bounds

Prompts, model results, tool arguments, commands, outputs, paths, attachments,
credentials and raw error messages are excluded. Correlation identifiers are
bounded SHA-256 prefixes. Provider strings use fixed vocabularies, or become
`other`/`unknown`; health metrics use an explicit scalar field allowlist.

Pending operations are bounded to 128, with eight shown per snapshot. Claude's
legacy debug events (written with the per-minute stream) are batched into at most
16 distinct labels per minute, with omitted observations counted in `dropped`. Each
label carries its count and its metrics summed over the batch: a number as
`{ n, min, max, sum }`, a boolean or `state` as a count per value. A batch is also
written when the process exits (`exit`, or `SIGTERM`/`SIGINT`, which is then left to
the process's own handlers or raised again), and `flushBufferedDebugLoggers()` writes
every open batch for a bridge's own shutdown path. Emitted JSON is limited to
8 KiB; oversized snapshots become an explicit `snapshot-overflow` record. That is
the limit: the logger's usual 2 KiB string bound is raised to the same 8 KiB for
this area alone, so a snapshot within it is never cut, including through a relay.
No per-token output or raw vendor debug logger is enabled.

Codex notification recordings remain a separate, explicitly acknowledged
capture facility. The application debug setting never enables them.

The [Cursor investigation](cursor-diagnostics.md) explains the incident that
motivated preserving more lifecycle evidence.
