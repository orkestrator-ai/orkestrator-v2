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
| `NativeAgentLaunchActivityReconciler` | `native-agent-launch-activity-reconciler.ts` | `observedSessionActivity` (the exact turn-edge state machine), activity sweep scheduling and per-group back-off, pending PR-monitor notifications, startup-launch tasks and retry, the rollback interval timer. |
| `NativeAgentPromptQueueDispatcher` | `native-agent-prompt-queue-dispatcher.ts` | The per-session work fence, mutation-intent counts, unpersisted Stop fences, queue drain tasks with their retry and attempt counts, the keyed queue scheduler, in-flight parked-dispatch settles. |
| `NativeAgentSessionOperations` | `native-agent-session-operations.ts` | No state. The session controls that are not a dispatch: Stop and its abort ladder (taking the dispatcher's mutation intent and turn-interrupt fences), background-task stop, suggested prompts, the resume list, resume and closing the session it replaced, fork, session and MCP actions, sign-in, composer controls and interaction answers. |

`native-agent-queue-message.ts` holds the pure `queue*` readers for one
persisted prompt-queue message, and `native-agent-projection-helpers.ts` the
projection's pure helpers (image paths, notices, usage merging, progress
folding, discovery keys).

What stays on the service is the work that is not a cluster of state: trusted
session input (coordinator authority), `ensureSession` / `adoptSession` /
`inspectSession`, bridge start and peek, the dispatch path
(`dispatchAdmittedPrompt` holds the storage lease across provider I/O), steer
(the persisted-steer dispatch it shares with the prompt queue), mail injection
and turn outcomes, provider teardown and moves. Its own state is the stop flag, the
initialization promise, the scan-task set every collaborator's background work
is tracked in (kept on the service, not the launch reconciler, because the
projection, interaction monitor, queue drains and launch scan all feed it and
shutdown drains it), and the turn-outcome retry bookkeeping.

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
dispatcher, the launch reconciler, the interaction tracker and the session
operations. A callback that
names a later collaborator only runs after construction.

Public service methods whose work moved (`getTranscriptUpdate`,
`reconcileAgentActivity`, `notifyPromptQueueChanged`, `withSessionWorkFence`,
`stopProjectionSession` and the rest) are one-line delegates, so callers and the command registry see the
same surface as before.

## Lifecycle

`init()` repairs persisted startup tabs, runs one launch scan and one queue
scan, then starts one driver: the keyed queue scheduler on the dispatcher
(`startKeyedScheduling`, the default) or the reconciler's rollback interval
(`startTimer`, under `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=native-queues`).
The interaction tracker then starts its observe-only monitor if enabled.
Background work never depends on a renderer being subscribed.

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
`createProviderSession`). `forTesting()` is visible to production code, but
only tests may call it. New collaborator state gets an entry in that
collaborator's `forTesting()`, not a field on the service.

`tests/unit/inheritance-chains.test.ts` keeps the class from being split into
`extends` layers again.
