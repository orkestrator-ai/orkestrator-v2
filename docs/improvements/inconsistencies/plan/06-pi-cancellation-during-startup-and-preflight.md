# 06 — Retain Pi cancellation through startup and preflight

Status: Planned.  
Depends on: [01](01-contract-baseline-and-regression-fixtures.md).  
Finding: INC-05.

## Target behavior

Once Pi has claimed a prompt, cancellation belongs to that exact operation even
if attachment or preflight has not produced a cancel handle yet. Returning from
the cancel route does not falsely claim the run has stopped. Later prompts must
never inherit an earlier turn's cancellation.

## Owners

- [Pi HTTP](../../../../bridges/pi-bridge/src/http.ts): prompt admission,
  cancel/abort aliases, deletion, and compaction exclusion.
- [Pi prompt lifecycle](../../../../bridges/pi-bridge/src/prompt.ts): acceptance,
  cancel handle installation, followRun, terminal cleanup.
- [Pi session state](../../../../bridges/pi-bridge/src/state.ts) and
  [activity projection](../../../../bridges/pi-bridge/src/public.ts).
- [Cursor comparison](../../../../bridges/cursor-bridge/src/http.ts): pending
  cancellation and prompt-sequence checks.
- [Backend abort ladder](../../../../apps/backend/src/core/native-agent-service-dispatch.ts)
  and [provider abort](../../../../apps/backend/src/core/http-bridge-provider.ts).

## Cancellation model

Define an admitted-turn token before the first await in prompt preparation.
This can be a reserved prompt sequence or a distinct operation ID, but all
phases must refer to the same token. `dispatching` is also used for configuration
and compaction, so it cannot by itself mean “there is a prompt to cancel.”

The token and pending cancellation are process-owned state, not persisted live
handles. After restart, uncertain prompt journals drive reconciliation; a stale
cancel flag must not attach to a new run.

| Phase | Cancellation behavior |
| --- | --- |
| Truly idle | No-op with `cancelled: false` |
| Prompt preparing before SDK invocation | Remember cancellation; prevent invocation once ownership is checked |
| SDK prompt started, preflight pending | Retain request and use abort as soon as the SDK can honor it |
| Active accepted run | Invoke the matching cancel handle |
| Config/compaction without a prompt claim | Follow that operation's existing contract; do not fabricate next-turn cancellation |
| Target run already settled | Clear only that token's cancellation; never cancel a newer run |

## Implementation tasks

- [ ] Reserve the token synchronously at prompt admission. Include image/file
  preparation, MCP reconciliation, session attachment, and durability waits in
  the token's ownership window.
- [ ] Add an optional pending-cancellation field keyed by that token. Clear stale
  state at the new claim, not after an await that could erase a current cancel.
- [ ] Change the cancel handler to capture the current prompt owner. If no handle
  exists but a prompt is genuinely admitted, record the intent and return a
  pending acknowledgement, matching the established Cursor HTTP 202 shape.
- [ ] Preserve denial of parked approvals before abort. A remembered cancel
  must not allow a newly reached approval hook to wait forever or approve by
  default while cancellation is being applied.
- [ ] After each preparation boundary, check whether cancellation or permanent
  closure won. If the SDK has not been invoked, settle locally without sending
  an artificial empty or cancelled prompt to the provider.
- [ ] Close the preflight gap inside `dispatchPrompt`. Register an observable
  abort path as early as the SDK supports, and consume a pending request when
  that path becomes valid. Validate early `session.abort()` semantics using
  pinned SDK types/source and current docs before assuming it cancels preflight.
- [ ] Do not wait forever for a preflight callback merely to discover a handle.
  If the provider cannot abort that phase, retain cancellation ownership and a
  bounded startup deadline; late acceptance must still be stopped and observed.
- [ ] Make concurrent cancels idempotent for one token. Await/observe the shared
  cancellation operation, and prevent its completion from clearing a new token.
- [ ] Clear pending cancellation on all terminal paths: preflight rejection,
  attachment error, local pre-send cancel, run success/error, timeout, deletion,
  and hard-abort escalation. Clear by identity, not unconditionally.
- [ ] Keep `running`/working until the provider or local pre-send path proves
  settlement. HTTP 202 means cancellation recorded, not execution stopped.
- [ ] Preserve Pi's provider-owned follow-up queue semantics. Do not allocate a
  fake new active-turn token for `followUp`; document whether interrupting the
  current run retains or clears queued follow-ups according to existing behavior.
- [ ] Check the backend's abort ladder still polls authoritative settlement and
  escalates when necessary. It currently ignores the successful response body;
  do not rely on a renderer reading `pending` to make cancellation effective.

## Regression matrix

Proposed files: `http-cancel-startup.test.ts` and `prompt-cancel-preflight.test.ts`
under `bridges/pi-bridge/src/`.

| Case | Required assertions |
| --- | --- |
| Cancel while cold attach is held | Intent retained; prompt not invoked if it can still be prevented |
| Cancel while mandatory write is held | No lost intent; release/failure settles the correct claim |
| Cancel while SDK preflight is held | Pending acknowledgement; eventual accepted work aborted |
| Preflight rejects after cancel | No double terminal transition or unhandled rejection |
| Two cancels for the same claim | One logical cancellation; stable response |
| Old cancel settles after new turn begins | New turn remains unaffected |
| Attachment/preflight fails before handle | Pending flag cleaned; next prompt runs normally |
| Idle/config/compaction state | No cancellation accidentally parked against a future prompt |
| Approval arrives during cancellation | Explicit deny; no abandoned approval promise |
| Follow-up queued during running turn | Existing queue policy remains observable and unchanged |
| Provider abort hangs | Backend remains busy/uncertain and escalation stays available |
| `/cancel` and `/abort` aliases | Identical ownership and acknowledgement behavior |

## Validation and real-stack scenario

Run focused Pi HTTP/prompt/session tests and Pi typecheck through the logged
runner. Add backend dispatch-service coverage for the pending-cancel response
and graceful-to-hard-stop path if its interpretation changes.

In an isolated Pi fixture, begin a cold-start prompt and interrupt immediately.
Switch to another environment while it settles, return, and reload. Verify the
turn does not continue unseen, activity settles only when justified, and no
approval remains unanswered. Then submit a separate prompt and verify it runs.
Use a deterministic fixture gate for the narrow race and a live smoke test only
for SDK integration; a manually fast click is not a reliable race reproduction.

## Acceptance

- [ ] Every admitted prompt has stable cancellation ownership before awaiting.
- [ ] Cancellation before preflight is retained and eventually honored.
- [ ] No stale cancel affects a later prompt or unrelated operation.
- [ ] No false idle/completed status appears while stop remains uncertain.
- [ ] Background/unmounted paths work without a mounted component or live event.
- [ ] Startup, approval, timeout, and cleanup promises all have rejection handlers.

