# 05 — Mid-turn control: steer and graceful interrupt

**Status:** 🟨 In progress · ~50% · Depends on: 02 (02 is now done)

Refreshed 2026-09-11. Shared abort ladder, dynamic `steerSupported`, and
production `/steer` exist for Codex, Claude, Pi, and Cursor. Still open:
Claude long-lived cross-turn `query()`, Grok/OpenCode steer, Cursor crash
recovery, and browser QA.

## Goal

Steering and graceful interruption exist in the shared model already
(`actions.steer`, `/session/:id/steer`, `steerStatus`, the backend steer
barrier) and work for Codex and Pi. Bring Claude and Cursor onto the same
surface, make Pi's queue authoritative, and replace "abort = kill the
process" with an interrupt-then-kill ladder everywhere. Grok stays
unsupported (ACP v1 has no mid-turn input) and says so through the
capability bit, which is fine.

## Normalized model

No new renderer surface. Changes are in the provider contract and bridges:

- `NativeAgentRuntimeProvider.abort` semantics documented as: request a
  graceful interrupt; escalate to process kill after a bounded grace period;
  report which happened via a `stopped` notice (`{ kind: "stopped" }` exists).
- `capabilities.actions.steer` becomes `true` for Claude and Cursor once
  their bridges pass the existing `steerSupported` runtime qualification
  (`http-bridge-provider.ts:323,347` currently hard-codes `codex|pi`).
- `capabilities.queue` for Pi means the bridge's own queue; the backend reads
  `GET /session/:id/queue` (dead today) into the projection's queue so there
  is one queue, not two.

## Tasks

### Backend

- [ ] Remove the `codex|pi` hard-code in `http-bridge-provider.ts:323,347`;
  qualify steer per bridge through `steerSupported` and the presence of the
  `/steer` route (404 → unsupported, per the "older bridge" convention).
- [ ] Abort ladder in the backend service: call provider `abort`, wait a
  bounded grace (recommend 5s), then a hard stop; emit the `stopped` notice
  with which rung fired. Tests for both rungs.
- [ ] Pi queue: read `/session/:id/queue` into the projection queue and
  reconcile with the backend-owned queue (bridge queue is authoritative for
  items the bridge already accepted; backend queue holds items not yet
  handed over). Delete the duplicate path once reconciled.

### Claude bridge (the large item)

- [ ] Move from one `query()` per turn to one long-lived `query()` per
  session driven by `streamInput()` (`session-manager-prompt.ts:751`,
  hand-rolled generator at `session-manager-persistence.ts:1290-1332`).
  Turns become messages on the input stream; `resume` is used only when the
  query is (re)created. Keep the at-most-once dispatch journal semantics:
  the journal records the message write, and `result.user_message_uuid`
  remains the reconciliation link.
- [ ] Implement `/session/:id/steer` on the Claude bridge by writing to the
  same input stream while a turn is running; report `steerStatus` from the
  journal exactly as Codex does. Declare `perTaskStopAffordance` so an
  interrupt no longer kills background tasks.
- [ ] Replace `abortController.abort()` in `session-manager-lifecycle.ts:502,531`
  with `Query.interrupt()`; keep the abort controller as the hard-stop rung.
  Consume the interrupt receipt (`still_queued`) to report whether the turn
  stopped or the input was only dequeued.
- [ ] `setPermissionMode()`, `setModel()` and `applyFlagSettings()` on the
  live query when the composer changes between turns, instead of recreating
  the query. This is what makes mid-session model or mode changes cheap.
- [ ] Retire the continuation-timer, `backgroundTaskControls` and
  `closeQueryControlIfUnused` machinery in `session-manager-prompt.ts` and
  `session-manager-background-tasks.ts` that existed only because each turn
  was a fresh process. Track the deleted line count in the PR.
- [ ] Idle detach: a long-lived query is a live CLI child. Detach on the same
  idle policy the Codex bridge uses (`detachableThreads`), and re-create on
  the next request. The activity route must stay a no-touch read.

### Cursor bridge

- [ ] Implement `/session/:id/steer` with `Run.steer(text)` and map
  `SteerAckOutcome` to `steerStatus` (`dispatched` on ack, `unknown`
  otherwise). Journal it the same way as the prompt dispatch.
- [ ] Render the resulting `user-message-appended` update (plan 03) so the
  steered text appears where the SDK placed it.
- [ ] `Run.onDidChangeStatus()` → activity transitions instead of inferring
  from `wait()`; `Run.cancel()` stays the hard rung.
- [ ] Crash recovery: on resume, `Agent.listRuns()` → if a run is still
  `running` from a previous bridge process, re-attach with `Agent.getRun()`
  or cancel with `cancelRun()`, and use `SendOptions.local.force` when the
  agent is wedged. Today resume failure silently creates a new agent
  (`agent-session.ts:144-152`).

### Pi bridge

- [ ] Use `session.followUp(text, images)` for prompts that arrive while a
  turn runs, instead of the 409 at `http.ts:678-680`; the bridge's queue
  route then reflects both steer and follow-up entries with their mode.
- [ ] Steer with images (`steer(text, images)`, second argument unused
  today).
- [ ] Honour `setSteeringMode`/`setFollowUpMode` from the user's Pi
  `settings.json` explicitly rather than implicitly, and report the mode in
  the queue entries.

### Grok bridge

- [ ] Keep `actions.steer` false. Delete or clearly fence the dormant
  `grok-interjection.ts` extension behind a feature flag with a comment
  pointing at the ACP v2 discussion.

## Verification

- [ ] Bridge tests: steer during a running turn on Claude and Cursor; steer
  when idle returns `absent`; interrupt returns the receipt.
- [ ] Backend tests: abort ladder rungs; Pi queue reconciliation.
- [ ] Browser, inactive-path: start a long Claude turn, steer it, switch
  environment, return, reload; the steered message and the outcome are in
  the transcript from the snapshot.
- [ ] Measure: Claude turn start latency before and after the long-lived
  query; record in the PR.

## Out of scope

OpenCode steering (`delivery: steer` is v2 only). Grok steering.

## Sequencing note (added 2026-09-06)

Plans 01–03 are done and 04 is substantially done, so this plan's dependency is
satisfied and it is ready to pick up. It was deliberately **not** started in
that same pass, for one reason worth recording before someone begins:

The Claude task — one long-lived `query()` driven by `streamInput()` instead of
one query per turn — is not separable from the four tasks under it. Retiring the
continuation timer, `backgroundTaskControls` and `closeQueryControlIfUnused`
only makes sense once the query outlives the turn, and the at-most-once dispatch
journal has to keep working across that change: the journal currently records a
*query start*, and it would have to record a *message write* instead, with
`result.user_message_uuid` still the reconciliation link. Landing half of that
leaves prompt dispatch in a state where a lost acknowledgement is neither
provably sent nor provably unsent, which is the one failure this repository's
prompt path is built to prevent.

The Cursor, Pi and backend tasks *are* separable and could land first — in
particular the abort ladder, which is backend-only and benefits every platform.
