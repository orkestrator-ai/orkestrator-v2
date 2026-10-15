# 02 — NativeAgentService: extract collaborators from the inheritance chain

Status: Proposed (2026-10-14). Priority: second.

## Problem

`NativeAgentService` is one class split across six files by size in
`7aee8366` (#417). All files are under `apps/backend/src/core/`:

| Layer | Lines | Own fields |
| --- | --- | --- |
| `native-agent-service-base.ts` | 1146 | ~67 protected/private + `storage`, `invoke`, `options` |
| `native-agent-service-dispatch.ts` | 1106 | 0 |
| `native-agent-service-projection.ts` | 4768 | 23 (progressive transcript) |
| `native-agent-service-prompt.ts` | 2009 | 2 |
| `native-agent-service-reconciliation.ts` | 1921 | 0 |
| `native-agent-service-provider.ts` | 942 | 0 (the only concrete class) |
| `native-agent-service.ts` | 2 | re-export |

That's 11.9k lines, or 12.8k with `native-agent-service-shared.ts`.

The layering doesn't help a reader. The base declares 30 `abstract` methods
(lines 347–430) that later layers implement: provider implements 19, prompt 5,
reconciliation 3, dispatch 2 and projection 2. Every layer calls code from a
layer after it:

- base:723/729 → `reconcilePendingLaunches()` (reconciliation)
- base:798/904/967 → `provider(input)` (provider)
- base:1002/1112 → `refreshProjection()` (projection)
- dispatch:199 → `dispatchPromptInternal()` (prompt); dispatch:340/398 → `trackScan()` (provider)
- projection:3475 → `provider()`; prompt:393 → `observeProvider()`; prompt:1290 → `drainPromptQueue()` (reconciliation)

To understand any one file, you need all six.

## Target design

Keep `NativeAgentService` as the public class with an unchanged surface. It
holds collaborators, each with private state and a narrow interface:

| Collaborator | State it owns (fields that move off the base today) |
| --- | --- |
| `ProviderRegistry` | `providers`, `providerDispatchCounts`, `providerConnections`, `retiringProviders`, `disposedProviders`, `absentBridgeUntil`; `provider()`, `observeProvider()`, evict/prune/retire, `isProviderCached` |
| `TranscriptProjection` | `projectionCache`, `projectionSync(+Bytes)`, `projectionRevisions`, `projectionHistory(+Bytes)`, `projectionMissingSince`, `projectionRefreshes`, `projectionRefreshDescriptors`, `projectionEpochs`, `toolDetailCache(+Bytes)`, `pinnedToolDetailRefs`, the 23 `progressive*` / `displayTailScheduler` / `projectedMessages` / `directHistoryPages` fields |
| `PromptQueueDispatcher` | `queueTasks`, `queueRetryAt`, `queueAttempts`, `queueScheduling`, `settlingDispatches`, `sessionWorkFences(+Count)`, `pendingSessionMutations`, `pendingTurnInterrupts`, `interruptFenceOverflow` |
| `LaunchActivityReconciler` | `launchTasks`, `launchRetryAt`, `activityRetryAt`, `activityAttempts`, `observedSessionActivity`, `scanTasks`, `activityScan*`, `launchTimer` |
| `InteractionTracker` | `interactionObservations`, `trackedInteractions`, `providerReportedInteractions`, `interactionRetryAt`, `interactionAttempts`, `monitoredInteractionSessionKeys`, `observedInteractionRevisions`, `interactionSelectionCursors`, `interactionGlobalSelectionCursor`, `interactionScan*`, `interactionTimer`, `pendingInteractionReads` |
| `OpenCodeRecovery` | `openCodeRecoveryTasks`, `openCodeRecoveryCandidates`, `openCodeManualPromptClaims`, `openCodeRecoveryDispatches` |
| `CatalogCache` | `modelCatalogCache`, `modelCatalogRefreshes`, `commandCatalogues` |

The `queue*` parsers are already pure functions. Move them to a module
instead of a class.

Collaborators take their dependencies through the constructor, mostly
`storage`, `invoke`, `ProviderRegistry` and a clock or timer port. A circular
need, such as the reconciler draining the prompt queue, becomes an explicit
callback passed in at construction rather than an abstract method.

## Order

Each step is one PR. After each one, the chain is a layer shorter or its base
loses fields.

1. **`ProviderRegistry`.** It resolves 19 of the 30 abstract methods, and
   nearly every other layer depends on it. Doing it first removes most of the
   upward calls.
2. **`CatalogCache`.** Small and self-contained, so it's a good way to test
   the pattern.
3. **`TranscriptProjection`.** The largest piece by far. It removes most of
   `native-agent-service-projection.ts`, and its state is already a separate
   cluster.
4. **`InteractionTracker`, then `OpenCodeRecovery`.**
5. **`PromptQueueDispatcher` and `LaunchActivityReconciler`.** Do these last:
   they hold the work fences and admission ordering, which is where
   correctness risk concentrates.
6. **Remove the empty layers.** `NativeAgentService` becomes one plain class
   that wires the collaborators together.

## Invariants to preserve (AGENTS.md)

- Background work isn't tied to UI state; timers keep running when no
  renderer is subscribed.
- Every queue and cache keeps its byte and count bounds
  (`toolDetailCacheBytes`, `projectionHistoryBytes`, …). Move each bound with
  its state.
- Approval timeouts, disconnects and generation death still deny.
- A close path never deletes a provider session.
- The storage lock is still held across provider I/O during dispatch (see
  `NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS` in `storage-base.ts`). The
  dispatcher's ordering against `storage.enqueueNativeAgentSessionMutation`
  must not change.

## Tests: the main cost

About 40 tests build the service with
`new NativeAgentService(storage, invoke, options)` and fake providers. That
part is fine. But private state is reached about 70 times through
`service as unknown as {...}`, about 216 times through the local `internals()`
helper (for example `native-agent-service-base.test.ts:199`), and through
about 126 bracketed string-key accesses. The most-touched members are:

`drainPromptQueues` (34), `queueRetryAt` (15), `observedSessionActivity` (14),
`flushDisplayTailPersist` (13), `trackedInteractions` (11), `providers` (11),
`queueAttempts` (10), `provider` (10), `progressiveTranscriptCache` (8).

Each extraction PR also:

1. adds direct unit tests for the new collaborator through its public
   interface,
2. moves the `internals()` reads for that collaborator's fields onto the
   collaborator's interface (or a test-only accessor on the collaborator, not
   the service),
3. leaves end-to-end service tests unchanged, as the regression oracle.

Don't rewrite the `internals()` call sites up front; migrate them one
collaborator at a time.

## Done when

- `native-agent-service-*.ts` no longer contains `abstract class`.
- The service has no `abstract` forward declarations.
- No test reads collaborator state through the service.
