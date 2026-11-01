# Bridge debug logging

Status: Living — shared bridge debug logging.

Set `bridge` or `bridge.diagnostics` to Debug or Trace in **Settings → Debug → Log
Detail**, or the default level to either. It applies to running local and Docker
bridges at once, with no restart. To keep what they write, turn on **Save Logs to
Disk** too; that also applies at once. [logging.md](logging.md#live-settings) covers
both controls and how the setting reaches a bridge.

The backend also passes `ORKESTRATOR_BRIDGE_DEBUG=1` or `0` to every new local and
Docker bridge, as its startup default until the setting arrives. Standalone bridges
accept the same variable. An unset common variable allows `CLAUDE_BRIDGE_DEBUG`,
`CODEX_BRIDGE_DEBUG`, `CURSOR_BRIDGE_DEBUG`, `PI_BRIDGE_DEBUG`, or `ACP_BRIDGE_DEBUG`
as a compatibility fallback. Only `1` enables logging; an explicit common `0`
overrides every legacy flag.

## Turning detail on during a turn

Every scope opens whether or not detail is on, and counts from the start. Only its
writes are gated. So turning detail on writes one `event=heartbeat` snapshot straight
away, covering the turn so far, and then one a minute. Keeping the scopes open costs
a few counters and a sha256 per tool call on every turn, plus one unreferenced timer.
No arguments are built for a snapshot while it is off.

| Bridge | A running turn or process | Gap |
| --- | --- | --- |
| Claude | The turn's scope reports at once, with its pending tools and clocks. `debugLog` sites and HTTP summaries start from the change. | Debug events before the change were never recorded. |
| Codex | The process scope reports at once. | None for this scope. Codex has no per-turn scope, on or off. |
| Cursor | The turn's public scope reports at once, with its pending tools and clocks. The SDK seam installs at that moment, and stays installed. | A transport already running is adopted at its next frame, so a completely silent one is not seen. A local execution already in progress is not seen; only later ones are. `transportAttempts` and frame counts start from the change. |
| Pi | The turn's scope reports at once, with its pending tools and approvals. | None. |
| ACP/Grok | The process scope reports at once, with its counters and pending requests. | None. |

A bridge without the route (an older container image) keeps its startup setting until
its next start. A level change reaches only what is on the shared logger, so it has no
visible effect on a bridge's own `console.*` lines until those migrate.

Search for `[bridge-diagnostics]`. These lines have not moved onto the
[shared logger](logging.md) yet, so they keep this format; they reach the desktop
log through the relay as unmigrated backend output. The JSON `bridge` field identifies `claude`,
`codex`, `cursor`, `pi`, or `acp` (Grok). Local output uses the existing application
log sink and its rotation and retention. Docker output goes to the existing
`/tmp/<provider>-bridge.log` files (`/tmp/grok-acp-bridge.log` for Grok).

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
event batching and log formatting. Bridge adapters describe their own events;
they do not own logging timers or copy the privacy and size policies.
`src/node/bridge-log-policy.ts` is the route every bridge shares.

Each active diagnostic scope reports once a minute, plus lifecycle boundaries.
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

Cursor also emits `event=sdk-snapshot` on the same timer and lifecycle
boundaries, correlated by the same hashed `session` and `run`. It follows the same
Log Detail setting as the other snapshots, with the gap the table above gives.

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
payloads are never retained by the diagnostic records. Each line is capped at
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
legacy debug events are batched into at most 16 distinct labels per minute,
with omitted observations counted in `dropped`. Emitted JSON is limited to
8 KiB; oversized snapshots become an explicit `snapshot-overflow` record.
No per-token output or raw vendor debug logger is enabled.

Codex notification recordings remain a separate, explicitly acknowledged
capture facility. The application debug setting never enables them.

The [Cursor investigation](cursor-diagnostics.md) explains the incident that
motivated preserving more lifecycle evidence.
