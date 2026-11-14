# Native agent service

`NativeAgentService` (`apps/backend/src/core/native-agent-service.ts`) is the
backend's entry point for native agent tabs: it ensures, adopts and inspects
provider sessions, dispatches prompts and steers, runs session actions, and
serves every transcript and state read the renderer makes. It is one plain
class. The state it used to keep in six `extends` layers now lives in
collaborators that own it privately, and the service wires them together.

## Collaborators

| Collaborator | File | State it owns |
| --- | --- | --- |
| `ProviderRegistry` | `native-agent-provider-registry.ts` | Cached providers, dispatch counts, bridge connections and generations, retiring and disposed providers, absent-bridge back-off. |
| `NativeAgentTurnRecovery` | `native-agent-turn-recovery.ts` | Incomplete-turn recovery tasks and candidates, manual-prompt claims, recovery dispatches. |
| `NativeAgentObservationBroker` | `native-agent-observation.ts` | Shared observation records, dispatch and generation fences, next-due provider groups. |
| `NativeAgentCatalogCache` | `native-agent-catalog-cache.ts` | Per-environment model catalogues and their coalesced refreshes; per-session command catalogues (through `NativeAgentCommandCatalogueCache`). |
| `NativeAgentTranscriptProjection` | `native-agent-transcript-projection.ts` | The legacy projection cache, sync revisions and history, epochs and in-flight refreshes, tool details, stop notices, pushed titles, the progressive transcript/state/discovery caches and reads, the display-tail scheduler, projected-message and direct-history-page caches, artifact overlays. |
| `NativeAgentInteractionTracker` | `native-agent-interaction-tracker.ts` | Interaction observations, sweep detections, the observe-only monitor timer and its round-robin cursors, per-session retry back-off, the pending-interaction read cache. |
| `NativeAgentLaunchActivityReconciler` | `native-agent-launch-activity-reconciler.ts` | `observedSessionActivity` (the exact turn-edge state machine), activity sweep scheduling and per-group back-off, pending PR-monitor notifications, startup-launch tasks and retry. |
| `NativeAgentPromptQueueDispatcher` | `native-agent-prompt-queue-dispatcher.ts` | The per-session work fence, mutation-intent counts, unpersisted Stop fences, queue drain tasks with their retry and attempt counts, the keyed queue scheduler, in-flight parked-dispatch settles. |
| `NativeAgentGoalService` | `native-agent-goal-service.ts` | An index of sessions with a running goal, per-session advance tasks, running checks. All durable goal state is on the session record; see [goals.md](goals.md). |
| `NativeAgentHandoffs` | `native-agent-handoffs.ts` | No state. "Continue in…": the full source-transcript read `create_agent_handoff` builds from, and the pending handoff a dispatch carries. |
| `NativeAgentSignInResends` | `native-agent-sign-in-resend.ts` | A bounded in-memory copy of each session's last accepted plain Claude prompt. The durable hold is on the session record; see [agent-accounts.md](agent-accounts.md). |
| `NativeAgentSessionOperations` | `native-agent-session-operations.ts` | No state. The session controls that are not a dispatch: Stop and its abort ladder (taking the dispatcher's mutation intent and turn-interrupt fences), background-task stop, suggested prompts, the resume list, resume and closing the session it replaced, fork, session and MCP actions, sign-in, composer controls and interaction answers. |
| `NativeAgentPromptDispatch` | `native-agent-prompt-dispatch.ts` | No state. Prompt dispatch: the intent path and its one bounded recovery retry, the at-most-once prompt path (`dispatchAdmittedPrompt`, which holds the storage lease across provider I/O), command planning, the parked-dispatch and parked-steer settles, retry and discard, prompt readiness, and steer (the persisted-steer dispatch it shares with the prompt queue). It is the one place the dispatch fence and lease order is written down; see [Dispatch fence order](#dispatch-fence-order). |
| `NativeAgentMailInjection` | `native-agent-mail-injection.ts` | No state. Agent mail delivered into a session: the presence gate, idle-turn injection, Deliver now's steer into a running turn, and the two reconciliations. It reaches dispatch only through `NativeAgentPromptDispatch`'s entry points, so it takes no fence or lease itself. |

`native-agent-queue-message.ts` holds the pure `queue*` readers for one
persisted prompt-queue message, and `native-agent-projection-helpers.ts` the
projection's pure helpers (image paths, notices, usage merging, progress
folding, discovery keys).

What stays on the service is the work that is not a cluster of state: trusted
session input (coordinator authority), `ensureSession` / `adoptSession` /
`inspectSession`, bridge start and peek, turn outcomes, provider teardown and
moves. A direct steer that misses its turn is handed by the prompt dispatch to
`native-agent-missed-steer.ts`, which sends it as a new turn or queues it. Its own state is the stop flag, the
initialization promise, the scan-task set every collaborator's background work
is tracked in (kept on the service, not the launch reconciler, because the
projection, interaction monitor, queue drains and launch scan all feed it and
shutdown drains it), and the turn-outcome retry bookkeeping.

## "Continue in…" handoffs

The frame, the budget and the record selection are one implementation in
`@orkestrator/protocol/agent-handoff-frame`, used by the interactive transfer
and the build pipeline's review handoff, and read back by the pipeline
transcript. The snapshot and its renderer are `@orkestrator/protocol/agent-handoff`.

- **Created by the backend.** `create_agent_handoff` (`agent-handoffs.ts`) reads
  the provider's whole transcript, refuses a session that is mid-turn or moves
  during the read, composes a prior transfer, measures the changes, and stores
  the immutable record. The renderer names the source and shows the result; it
  used to build this from whatever window it had loaded.
- **Delivered at dispatch, for every sender.** While the tab references a handoff
  that nothing has consumed, `dispatchAdmittedPrompt` prepends its carrier inside
  the at-most-once window. The delivery is recorded in the same session write that
  journals the request (`deliveredAgentHandoffIds`). A parked ambiguous request
  keeps the handoff id on its pending record: a retry sends the same carrier, a
  confirmation records the delivery, and a discard leaves it pending for the next
  message. The destination's transcript is checked too, because a request an older
  renderer delivered is in no journal. If that read fails the dispatch is refused
  before anything is journaled, since neither guess is safe.
- **What cannot carry history is refused.** A resolved command (its text must reach
  the executor as typed) and a goal being set or resumed are rejected while a
  handoff is pending, whichever client sent them; the renderer's own check is an
  early copy of the same rule. `/compact` and reading goal status are not affected.
- **Pruned by the backend.** A layout write that drops a reference prunes, and the
  orphaned-tab reconcile sweeps, both past `AGENT_HANDOFF_PRUNE_GRACE_MS`: a handoff
  is stored before the layout that references it. A renderer only evicts its cache.

## Wiring

Every collaborator takes a host object through its constructor. A host lists
exactly what the collaborator needs from outside: shared values (`storage`,
`options`, `invoke`, and where needed the registry, broker or recovery) and
callbacks. The service builds each host from arrow functions, so a callback
always reaches the current method, and a circular need (the reconciler
dispatching the startup prompt, the dispatcher settling a parked dispatch, the
projection scheduling that settle) is a callback rather than an abstract
method. The service constructs, in order: catalogues, the observation broker,
the provider registry, turn recovery, the projection, the prompt-queue
dispatcher, the launch reconciler, the goal service, the interaction tracker,
the session operations, the handoffs, the sign-in resends, then the prompt
dispatch and mail injection. A callback that names a later collaborator only
runs after construction. The prompt dispatch is built on first use through a
getter rather than assigned in the constructor, so a service assembled from
the prototype alone (`native-agent-bridge-replacement.test.ts`) still reaches
the real dispatch admission; the constructor builds it when it wires mail
injection.

## Dispatch fence order

Every fence and lease a prompt or steer takes is taken in
`NativeAgentPromptDispatch`, in this order:

1. the bridge reservation (`beginBridgeWork`, refused while a wider-policy
   bridge replacement runs);
2. the environment agent-work fence (`environmentFence.beginAgentWork`);
3. the session mutation intent (`dispatchIntent`) or mutation fence
   (`dispatchPrompt` and the internal path) on
   `NativeAgentPromptQueueDispatcher`;
4. the storage lease, `dispatchNativeAgentPromptOnce`, held across provider
   I/O;
5. inside it, the observation dispatch fence (`observations.beginDispatch`).

A steer takes the mutation fence around `dispatchNativeAgentSteerOnce`. Stop
(`NativeAgentSessionOperations`) takes the same dispatcher fences
(`withSessionMutationIntent`, `fenceTurnInterrupt`) in the same order. The
fence *state* lives on the dispatcher, so dispatch and Stop share it without
sharing a class: putting both in one "turn lifecycle" class would have made
one class of about 2,600 lines. Mail injection runs its admission check as the
dispatch's `prepare`, under the same lease as a typed prompt.
`native-agent-prompt-dispatch.test.ts` pins this order.

Public service methods whose work moved (`getTranscriptUpdate`,
`reconcileAgentActivity`, `notifyPromptQueueChanged`, `withSessionWorkFence`,
`stopProjectionSession`, `dispatchIntent`, `dispatchMailInject` and the rest)
are one-line delegates, so callers and the command registry see the
same surface as before.

## Lifecycle

`init()` repairs persisted startup tabs, runs one launch scan and one queue
scan, then starts the keyed queue scheduler on the dispatcher
(`startKeyedScheduling`). It is the only driver: the reconciler's rollback
interval was removed (todo 0048 task 13), and
`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` no longer names this domain.
The interaction tracker then starts its observe-only monitor if enabled.
Background work never depends on a renderer being subscribed.

A queue drain sends its head only to a session whose last turn reads idle.
A terminal error holds the queue with back-off and then parks the head with
the provider's explanation, so an at-capacity model cannot burn a whole
queue. A turn a provider restart cut short (`status: "error"` with
`interruption: "restart"`, which the Claude and Codex bridges report) is not
a model failure: the drain sends the head at once, as after an idle turn, so
a prompt queued before the restart still goes out before one typed after it.
Added 2026-11-13 (7120 (retired), task 1); the live check
(`multi-client-restarts-live.spec.ts`, backend crash case) saw the queued
prompt go out once, before the later one.

`shutdown()` sets the stop flag (every collaborator reads it through
`isStopped`), stops the timers and scheduler, settles projection refreshes and
catalogue reads, drains progressive reads and display tails, waits for every
tracked scan, then loops until launch tasks, queue drains and recovery tasks are
all gone before shutting the provider registry down and clearing caches.

## Invariants the split keeps

- Every queue and cache keeps its byte and count bound, and the bound lives
  with its state.
- The storage lease is held across provider I/O during dispatch, and queue
  admission still orders against `storage.enqueueNativeAgentSessionMutation`.
- A Stop that storage has not acknowledged fences publication; past 256 such
  Stops every outcome reads `unknown` rather than evicting one.
- Approval timeouts, disconnects and generation death still deny; interaction
  observations are advisory and never answer a request.
- No close path deletes a provider session.

## Tests

Each collaborator has direct tests through its public interface
(`native-agent-*.test.ts` beside it). The `native-agent-service-*.test.ts`
suites drive the whole service and are the regression oracle.

A service test that needs a collaborator's state reaches the collaborator with
`collaborators(service)` from `native-agent-service-test-collaborators.ts`, and
reads its state through the collaborator's `forTesting()` accessor
(`projectionInternals`, `interactionInternals`, `launchInternals` and
`queueInternals` are shorthands). Tests never read collaborator state through
fields on the service; the service-level `internals()` casts left in the suites
reach only the service's own seams (`provider`, `bridgeConnection`,
`createProviderSession`, `tabMailFor`, and `dispatchPromptInternal`, a private
delegate the recovery, resend and launch collaborators also call). `forTesting()` is visible to production code, but
only tests may call it. New collaborator state gets an entry in that
collaborator's `forTesting()`, not a field on the service.

`tests/unit/inheritance-chains.test.ts` keeps the class from being split into
`extends` layers again.
