# Native agent service collaborators

Checked against `main` at `2459b05c` (2026-10-15).

`NativeAgentService` is one class cut by size into six `extends` layers held
together by abstract forward declarations. Every layer calls code in a later
one, so understanding any file means reading all six. The goal is one plain
class with an unchanged public surface that wires collaborators, each owning
its state privately behind a narrow interface.

## Current state

- The chain, all in `apps/backend/src/core/` (about 11,500 lines, plus 907 in
  `native-agent-service-shared.ts`):

  | Layer | File | Lines |
  | --- | --- | ---: |
  | `NativeAgentServiceBase` | `native-agent-service-base.ts` | 1,351 |
  | `NativeAgentServiceDispatch` | `native-agent-service-dispatch.ts` | 1,118 |
  | `NativeAgentServiceProjection` | `native-agent-service-projection.ts` | 5,007 |
  | `NativeAgentServicePrompt` | `native-agent-service-prompt.ts` | 1,900 |
  | `NativeAgentServiceReconciliation` | `native-agent-service-reconciliation.ts` | 1,648 |
  | `NativeAgentServiceProvider` (the only concrete class) | `native-agent-service-provider.ts` | 506 |

  `native-agent-service.ts` re-exports the concrete class as
  `NativeAgentService`.
- Collaborators already extracted:
  - `ProviderRegistry` (`native-agent-provider-registry.ts`, #977): provider
    cache, dispatch counts, connections, retirement and absent-bridge
    back-off;
  - `NativeAgentTurnRecovery` (`native-agent-turn-recovery.ts`, #970):
    incomplete-turn recovery tasks, candidates, manual-prompt claims and
    recovery dispatches. It replaced the OpenCode-only recovery state, so no
    separate `OpenCodeRecovery` step is needed;
  - `NativeAgentCommandCatalogueCache` (`native-agent-command-catalogue.ts`),
    held on the base as `commandCatalogues`.
- `native-agent-service-base.ts` still has 22 abstract declarations:
  - `trackScan`, `reconcilePendingLaunches`, `drainPromptQueues`,
    `forgetPendingInteractions`, `reconcileAgentInteractions`;
  - `assertAcceptingWork`, `assertEnvironmentLive`, `assertSessionIdentity`,
    `createProviderSession`, `assertProjectionInput`;
  - `refreshProjection`, `dispatchIntentInternal`, `dispatchPromptInternal`,
    `invalidateProjection`, `drainPromptQueue`, `composeDraftHoldsQueue`;
  - six `queue*` parsers (`queueExecutionMode`, `queueDispatchMode`,
    `queueString`, `queueReasoningEffort`, `queueFastMode`, `queueBoolean`).
- The remaining state clusters still live on the base (or, for the
  progressive transcript, on the projection layer): `projectionCache`,
  `toolDetailCache`, `queueTasks`, `queueRetryAt`, `sessionWorkFences`,
  `pendingTurnInterrupts`, `launchTasks`, `observedSessionActivity`,
  `launchTimer`, `interactionObservations`, `trackedInteractions`,
  `interactionTimer`, `modelCatalogCache`, `modelCatalogRefreshes` and others
  listed in the target table below.
- Tests: 21 `native-agent-service*.test.ts` files. They reach private state
  about 72 times through `as unknown as`, 216 times through the local
  `internals()` helper, and about 130 times through bracketed string keys.
- `tests/unit/inheritance-chains.test.ts` pins this chain in `PINNED_CHAINS`,
  with `plan: "docs/todo/backend-structure/0010-native-agent-service-collaborators.md"`. The test
  fails if the pinned class list no longer matches the source, and it asserts
  that the `plan` file exists.

## Outstanding work

### Code

One PR per step, in this order. **Every step must update the native-agent
entry in `PINNED_CHAINS` in `tests/unit/inheritance-chains.test.ts`**: remove
the layers the step emptied, and keep `plan` pointing at this file while the
chain exists. When the last layer goes, remove the entry and delete this file
in the same change.

1. **`CatalogCache`**: `modelCatalogCache`, `modelCatalogRefreshes` and the
   existing `commandCatalogues`. Small and self-contained, so it proves the
   pattern.
2. **`TranscriptProjection`**: the projection, tool-detail and progressive
   transcript state, and most of `native-agent-service-projection.ts`.
3. **`InteractionTracker`**.
4. **`PromptQueueDispatcher`** (work fences, admission ordering) and
   **`LaunchActivityReconciler`**. These go last because correctness risk
   concentrates there.
5. **Move the `queue*` parsers** into a module of pure functions.
6. **Remove the empty layers.** `NativeAgentService` becomes one plain class
   that wires the collaborators together.

Target ownership:

| Collaborator | State it owns |
| --- | --- |
| `ProviderRegistry` (done) | providers, dispatch counts, connections, retiring and disposed providers, absent-bridge back-off |
| `NativeAgentTurnRecovery` (done) | recovery tasks, candidates, manual-prompt claims, recovery dispatches |
| `CatalogCache` | `modelCatalogCache`, `modelCatalogRefreshes`, `commandCatalogues` |
| `TranscriptProjection` | `projectionCache`, `projectionSync(+Bytes)`, `projectionRevisions`, `projectionHistory(+Bytes)`, `projectionMissingSince`, `projectionRefreshes`, `projectionRefreshDescriptors`, `projectionEpochs`, `toolDetailCache(+Bytes)`, `pinnedToolDetailRefs`, the `progressive*` fields, `displayTailScheduler`, `projectedMessages`, `directHistoryPages` |
| `PromptQueueDispatcher` | `queueTasks`, `queueRetryAt`, `queueAttempts`, `queueScheduling`, `settlingDispatches`, `sessionWorkFences(+Count)`, `pendingSessionMutations`, `pendingTurnInterrupts`, `interruptFenceOverflow` |
| `LaunchActivityReconciler` | `launchTasks`, `launchRetryAt`, `activityRetryAt`, `activityAttempts`, `observedSessionActivity`, `scanTasks`, `activityScan*`, `launchTimer` |
| `InteractionTracker` | `interactionObservations`, `trackedInteractions`, `providerReportedInteractions`, `interactionRetryAt`, `interactionAttempts`, `monitoredInteractionSessionKeys`, `observedInteractionRevisions`, `interactionSelectionCursors`, `interactionGlobalSelectionCursor`, `interactionScan*`, `interactionTimer`, `pendingInteractionReads` |

Collaborators take their dependencies through the constructor: mostly
`storage`, `invoke`, `ProviderRegistry` and a clock or timer port. A circular
need, such as the reconciler draining the prompt queue, becomes a callback
passed in at construction, not an abstract method.

Done when:

- no `native-agent-service-*.ts` file contains `abstract class`;
- the service has no abstract forward declarations;
- no test reads collaborator state through the service, and the pinned entry
  is gone from `inheritance-chains.test.ts`.

### Qualification

Each extraction PR also:

1. adds direct unit tests for the new collaborator through its public
   interface;
2. moves the `internals()` reads for that collaborator's fields onto the
   collaborator (or a test-only accessor on the collaborator, not the
   service);
3. leaves the end-to-end service tests unchanged, as the regression oracle.

Do not rewrite the `internals()` call sites up front; migrate them one
collaborator at a time. The most-touched members when this was planned were
`drainPromptQueues`, `queueRetryAt`, `observedSessionActivity`,
`flushDisplayTailPersist`, `trackedInteractions`, `providers`,
`queueAttempts`, `provider` and `progressiveTranscriptCache`.

## Constraints and rationale

- Background work is not tied to UI state: timers keep running with no
  renderer subscribed.
- Every queue and cache keeps its byte and count bounds (for example
  `toolDetailCacheBytes`, `projectionHistoryBytes`). Each bound moves with its
  state.
- Approval timeouts, disconnects and generation death still deny.
- A close path never deletes a provider session.
- The storage lease is still held across provider I/O during dispatch
  (`NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS`), and the dispatcher's ordering
  against `storage.enqueueNativeAgentSessionMutation` does not change.
- `AGENTS.md` "Splitting large classes": collaborators that take a shared
  context, not `extends` layers.

## Related

- [0009-storage-service-repositories.md](0009-storage-service-repositories.md), the
  matching plan for `StorageService`.
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md): the
  `native-agent` folder slice; doing it after this work avoids moving files
  that are about to be split.
- [`agent-engines.md`](../../architecture/agent-engines.md).

## Replaces

- `docs/2026-10-14/02-native-agent-service-collaborators.md`
