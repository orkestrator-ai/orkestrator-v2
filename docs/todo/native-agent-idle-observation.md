# Native agent idle observation

Checked against `main` at `2459b05c` (2026-10-15).

An idle native session still costs a no-touch activity read on every 2 s
backend sweep for each HTTP-bridge provider, and a 1,500 ms client read for
Claude and Codex views. Either can slow down only once the provider's idle
state cannot change without an announced event. The remaining work is to add
that event coverage per provider, enable the backoff that already exists, and
let several views of one session share their reads.

## Current state

- `NativeAgentObservationBroker` (`apps/backend/src/core/native-agent-observation.ts`)
  is the single observer. It joins compatible reads (`OBSERVATION_FRESHNESS_MS`,
  1 s), fences each dispatch (`beginDispatch`) and each provider generation,
  and bounds its records (`MAX_OBSERVATION_RECORDS`, `MAX_OBSERVATION_GROUPS`,
  `MAX_OBSERVATION_DISPATCH_FENCES`). The sweep runs every 2 s
  (`ACTIVITY_JOB_MS` in `apps/backend/src/core/index.ts`).
- Backend idle backoff. A group whose sessions read idle
  `STABLE_IDLE_READS_BEFORE_BACKOFF` (3) times may skip sweeps until a 4 s
  safety read (`STABLE_IDLE_BACKOFF_MS`), but only when its row in
  `NATIVE_AGENT_OBSERVATION_CAPABILITIES` names an `idleBackoffWakeup` and the
  provider reports that wakeup live. Only OpenCode has one
  (`"provider-event-stream"`, `OpenCodeProvider.observationStreamLive`). Every
  HTTP-bridge group (Claude, Codex, Cursor, Pi, Grok) is read on every sweep:
  the backend does not subscribe to bridge event streams, which serve legacy
  renderer clients only.
- Client quiet backoff. `apps/web/src/lib/native-session-read-policy.ts` slows
  an idle, unchanged view through `NATIVE_QUIET_BACKOFF_TRIAL_MS` (3, 5, 10,
  15 s) for `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS` (Cursor, Pi, Grok,
  OpenCode, in `packages/protocol/src/native-agent-observation.ts`) when the
  backend advertises `observationEventVersions`. The backend announces every
  activity transition with a generation and revision stamp, and
  `apps/web/src/lib/native-observation-events.ts` turns announcements into
  invalidations and a gap into a re-read of every view.
- Claude and Codex are not qualified and keep 1,500 ms when idle. Claude
  background-task output, and Codex async questions and background terminals,
  change an idle view without an announced transition.
- `useNativeAgentSession` keys its coordinated read by hook instance
  (`view: readInstanceId`). Each instance applies reads into its own fenced
  state (sequence and epoch, conditional tokens), so two mounted views of one
  session do not share reads.
- Mail presence keeps its 2 s refresh and 4 s TTL (`OBSERVED_PRESENCE_TTL_MS`
  in `agent-mail-service.ts`). The injection gate trusts a retained idle only
  if it is post-dispatch and at most `MAIL_INJECT_OBSERVATION_MAX_AGE_MS`
  (4 s) old; otherwise it reads provider status. Presence stays authoritative
  only because HTTP groups never back off.
- Queue passes skip the provider read when a fresh, provider-confirmed busy
  observation exists (`QUEUE_BUSY_OBSERVATION_MAX_AGE_MS`); idle for dispatch
  always comes from a current status read.
- The interaction observer (inventory B08) runs only when
  `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1` sets `interactionMonitorMode`
  to `"observe-only"` (`native-agent-service-prompt.ts`). It was left unchanged.
- Rollback: `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` restores the previous
  per-provider cadence; emptying `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`
  removes client backoff. See
  [recurring-work-qualification.md](recurring-work-qualification.md) for when
  the switch goes.

## Outstanding work

### Code

1. Give HTTP-bridge groups an idle wakeup. Subscribe the backend to each
   bridge's event stream with replay cursors and gap marking, then set
   `idleBackoffWakeup` for that provider's row. Done when a stably idle group
   skips sweeps and an externally started turn, a lost event or a bridge
   restart is still discovered within the activity budget.
2. Announce what Claude and Codex currently change silently. Emit a stamped
   activity announcement (or a new invalidation) for Claude background-task
   output and for Codex async-question and background-terminal changes on an
   idle thread. Then qualify each provider and add it to
   `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`.
3. Share native reads across hook instances. Move the instance-local fenced
   state (sequence, epoch, conditional tokens) into a shared store keyed by
   connection, session and view window, then key the coordinated read by
   session instead of `readInstanceId`.
4. If HTTP groups ever back off, represent mail presence explicitly as stale
   or unknown. A slower observation must never read as permission to inject
   into an active session.

### Qualification

Live coverage per provider (Claude, Codex, Cursor, Pi, Grok, OpenCode) in an
isolated `dev:test` profile with credentials, batched with
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md):

- a missed final event;
- a parked approval;
- background sub-agents;
- reconnect, and idle detach then reattach;
- completion while the client is hidden;
- completion with no renderer connected, then rehydration on another client.

Today's evidence is fake providers, a real HTTP server for the no-touch proof
and the real OpenCode SDK client for the event stream only.

## Constraints and rationale

- Observation stays on the no-touch `/activity` route, never `/status`. It
  never starts a bridge, attaches, hydrates or refreshes liveness.
- Idle is never served from cache for dispatch, and a pre-dispatch idle can
  never advance a pipeline or drain another prompt. Dispatch and generation
  fences stay.
- A failed observation evicts a provider without disposing it; the replaced
  provider is retired only after its dispatches settle plus a grace period.
- Budgets (p95): pending approval visible within 2 s on an active view,
  background activity indicator within 4 s, turn completion or queued
  dispatch within 3 s. The backend's 4 s safety read keeps a lost event inside
  the activity budget. Source: the
  [recurring baseline](../improvements/recurring-processes/baseline/README.md).
- Responsive phases (running, blocked, cancelling, recovering) never back off
  on the client.
- A provider whose events stay incomplete keeps its fallback reads. Do not
  claim universal event-driven support.
- An older backend without stamped announcements keeps the baseline cadence.

## Open questions

- Is subscribing to bridge event streams worth it for Cursor, Pi and Grok,
  which already have client quiet backoff, or only for Claude and Codex?
- Should the B08 interaction observer be retired or folded into the broker?

## Related

- [remote-client-bandwidth.md](remote-client-bandwidth.md): client-side
  bandwidth and the data-saving preference.
- [client-reconnect-and-freshness.md](client-reconnect-and-freshness.md):
  disconnect signals for the read coordinator.
- [recurring-work-qualification.md](recurring-work-qualification.md): live
  evidence against the budgets and rollback-switch removal.
- [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md):
  interaction contract gaps per provider.
- `../architecture/event-snapshot-recovery.md` ("Native observation
  invalidations") and `../imrovements/recurring-processes.md` (inventory rows
  C01 and B06 to B10).
- Living-doc drift to fix:
  - `event-snapshot-recovery.md` titles the section "Native observation
    invalidations (step 07)"; drop the step label.
  - No living doc carries the provider observation capability matrix; it
    exists only as `NATIVE_AGENT_OBSERVATION_CAPABILITIES`. A short table in
    `../architecture/agent-engines.md` would help.

## Replaces

- `docs/improvements/recurring-processes/plan/07-agent-observation-and-activity.md`
  (deferrals: HTTP-bridge wakeup, Claude and Codex qualification,
  cross-instance sharing, live providers, B08)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 8, Claude and Codex gating)
- `docs/imrovements/recurring-processes.md` (kept; findings F05 and F06,
  inventory rows C01 and B06 to B10)
