# Bridge debug logging

Status: Living — shared bridge debug logging.

Enable **Settings → Save Logs for Debugging**, save, and restart Orkestrator
with the updated build. The desktop log sink reads the setting at startup.
The backend explicitly passes `ORKESTRATOR_BRIDGE_DEBUG=1` or `0` to every
new local and Docker bridge. Changing the setting does not restart an existing
agent or interrupt its work. Restart Docker bridges as well if they were
already running before the setting changed.

Standalone bridges accept the same variable. An unset common variable allows
`CLAUDE_BRIDGE_DEBUG`, `CODEX_BRIDGE_DEBUG`, `CURSOR_BRIDGE_DEBUG`,
`PI_BRIDGE_DEBUG`, or `ACP_BRIDGE_DEBUG` as a compatibility fallback. Only `1`
enables logging; an explicit common `0` overrides every legacy flag.

Search for `[bridge-diagnostics]`. The JSON `bridge` field identifies `claude`,
`codex`, `cursor`, `pi`, or `acp` (Grok). Local output uses the existing application
log sink and its rotation and retention. Docker output goes to the existing
`/tmp/<provider>-bridge.log` files (`/tmp/grok-acp-bridge.log` for Grok).

## Shared implementation

`packages/protocol/src/bridge-diagnostics.ts` owns flag interpretation, periodic
snapshots, correlation ID hashing, metadata filtering, pending-operation bounds,
event batching and log formatting. Bridge adapters describe their own events;
they do not own logging timers or copy the privacy and size policies.

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
