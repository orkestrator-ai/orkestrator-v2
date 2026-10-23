# Native agent service collaborators

Planned against `main` at `2459b05c` (2026-10-15). Done on
`todo-0010-native-agent-collaborators-3fc4749e0985` from `06297124`
(2026-10-23). Every item below is done. The durable description now lives in
[`native-agent-service.md`](../../architecture/native-agent-service.md); delete
this file and its index row once the branch has merged (see decision 12).

`NativeAgentService` was one class cut by size into six `extends` layers held
together by abstract forward declarations. The goal was one plain class with an
unchanged public surface that wires collaborators, each owning its state
privately behind a narrow interface.

## Current state

- The chain is gone. `native-agent-service-base.ts`, `-dispatch.ts`,
  `-projection.ts`, `-prompt.ts`, `-reconciliation.ts` and `-provider.ts` are
  deleted. `NativeAgentService` is a plain class in
  `apps/backend/src/core/native-agent-service.ts` (3,880 lines, down from
  about 11,500 across the six layers) with no `abstract` member.
- Collaborators, each constructed with a host object that names exactly what
  it needs:

  | Collaborator | File | Lines |
  | --- | --- | ---: |
  | `ProviderRegistry` (before this work) | `native-agent-provider-registry.ts` | 434 |
  | `NativeAgentTurnRecovery` (before this work) | `native-agent-turn-recovery.ts` | 526 |
  | `NativeAgentCatalogCache` | `native-agent-catalog-cache.ts` | 250 |
  | `NativeAgentTranscriptProjection` | `native-agent-transcript-projection.ts` | 5,303 |
  | `NativeAgentInteractionTracker` | `native-agent-interaction-tracker.ts` | 861 |
  | `NativeAgentLaunchActivityReconciler` | `native-agent-launch-activity-reconciler.ts` | 1,472 |
  | `NativeAgentPromptQueueDispatcher` | `native-agent-prompt-queue-dispatcher.ts` | 757 |
  | `queue*` readers (pure functions) | `native-agent-queue-message.ts` | 96 |

- The native-agent entry is gone from `PINNED_CHAINS` in
  `tests/unit/inheritance-chains.test.ts`, which passes.
- Tests reach collaborator state through
  `native-agent-service-test-collaborators.ts` (`collaborators(service)` and
  each collaborator's `forTesting()` accessor). The service-level
  `internals()` helpers that remain (26 call sites, down from 216) reach only
  the service's own seams: `provider`, `bridgeConnection` and
  `createProviderSession`.

## Outstanding work

### Code

All six steps are done, one commit each on the branch (decision 2):

1. **Done — `CatalogCache`** (`ed4b6de95`): `NativeAgentCatalogCache` owns
   `modelCatalogCache`, `modelCatalogRefreshes` and the command catalogue
   cache, and computes catalogue keys itself.
2. **Done — `TranscriptProjection`** (`b614d6da9`):
   `NativeAgentTranscriptProjection` owns the projection, sync, history,
   epoch, refresh, tool-detail, stop-notice, pushed-title and progressive
   state, the display-tail scheduler and the projected-message and
   direct-page caches, plus the module helpers of the old projection layer.
3. **Done — `InteractionTracker`** (`855ba7d14`).
4. **Done — `PromptQueueDispatcher`** (`990a9b276`) **and
   `LaunchActivityReconciler`** (`1de86e32c`).
5. **Done — the `queue*` parsers** (`660377ff8`) are pure functions in
   `native-agent-queue-message.ts`; `composeDraftHoldsQueue` is called
   directly.
6. **Done — empty layers removed.** The merge commit (`b59198620`) folded the
   six layers into one class before any extraction (decision 1); the final
   cleanup removed the merge markers and the `type X = shared.X` aliases and
   made every remaining service member `private`.

Ownership as built (differences from the plan's table are decisions 5–8):

| Collaborator | State it owns |
| --- | --- |
| `ProviderRegistry` | providers, dispatch counts, connections, retiring and disposed providers, absent-bridge back-off |
| `NativeAgentTurnRecovery` | recovery tasks, candidates, manual-prompt claims, recovery dispatches |
| `NativeAgentCatalogCache` | `modelCatalogCache`, `modelCatalogRefreshes`, `commandCatalogues` |
| `NativeAgentTranscriptProjection` | `projectionCache`, `projectionSync(+Bytes)`, `projectionRevisions`, `projectionHistory(+Bytes)`, `projectionMissingSince`, `projectionRefreshes`, `projectionRefreshDescriptors`, `projectionEpochs`, `toolDetailCache(+Bytes)`, `pinnedToolDetailRefs`, `stopNotices`, `pushedSessionTitles`, the `progressive*` fields, `interactiveSnapshotShares`, `displayTailScheduler`, `remoteToolDetailReads`, `projectedMessages`, `directHistoryPages`, `artifactOverlays` |
| `NativeAgentPromptQueueDispatcher` | `queueTasks`, `queueRetryAt`, `queueAttempts`, `queueScheduling`, `settlingDispatches`, `sessionWorkFences(+Count)`, `pendingSessionMutations`, `pendingTurnInterrupts`, `interruptFenceOverflow` |
| `NativeAgentLaunchActivityReconciler` | `launchTasks`, `launchRetryAt`, `activityRetryAt`, `activityAttempts`, `observedSessionActivity`, `pendingPrRefreshEnvironmentIds`, `activityScan*`, `launchTimer` |
| `NativeAgentInteractionTracker` | `interactionObservations`, `trackedInteractions`, `providerReportedInteractions`, `interactionRetryAt`, `interactionAttempts`, `monitoredInteractionSessionKeys`, `observedInteractionRevisions`, `interactionSelectionCursors`, `interactionGlobalSelectionCursor`, `interactionScan*`, `interactionRevisionReconciliations`, `interactionMonitorAdoptionEnabled`, `interactionTimer`, `pendingInteractionReads` |
| `NativeAgentService` (kept) | `stopped`, `initialization`, `scanTasks`, `turnOutcomeAttempts`, the storage-listener unsubscribe, and the shared `observations` broker it passes to the registry and the reconciler |

Done when, checked on the branch:

- no `native-agent-service-*.ts` file contains `abstract class` — done;
- the service has no abstract forward declarations — done;
- no test reads collaborator state through the service, and the pinned entry
  is gone from `inheritance-chains.test.ts` — done (decision 10).

### Qualification

Done for every extraction:

1. **Direct unit tests** through each public interface:
   `native-agent-catalog-cache.test.ts` (8),
   `native-agent-transcript-projection.test.ts` (6),
   `native-agent-interaction-tracker.test.ts` (8),
   `native-agent-launch-activity-reconciler.test.ts` (8),
   `native-agent-prompt-queue-dispatcher.test.ts` (8) and
   `native-agent-queue-message.test.ts` (6).
2. **`internals()` reads moved onto the collaborators**, one collaborator per
   commit, through `forTesting()` accessors (`projectionInternals`,
   `interactionInternals`, `launchInternals`, `queueInternals`). The same
   applies outside the service suites: `index.test.ts`,
   `commands-state-sync.test.ts`, `native-agent-projection-entries.test.ts`,
   `native-agent-progressive-metrics.test.ts`, `public-api/test-provider.ts`
   and `scripts/recurring-baseline-native.ts`.
3. **End-to-end service tests unchanged as the regression oracle.** Only their
   access paths changed; no assertion, timeout or skip did. The
   `native-agent-*.test.ts` set went from 891 tests in 46 files (after the
   merge commit, identical to before it) to 935 in 52 files, all passing.

Evidence on macOS arm64, Bun 1.4.2: the 52 native-agent files pass under
`bun test --cwd apps/backend <files> --parallel=8`; both backend `tsc`
projects, `oxlint` and `oxfmt --check` pass. One parallel run hit the open
flake 0247 (`activity sweep over the batch route`, no bridge requests); the
recurrence is recorded in its case file and the owning file passed alone three
times. `mise run test` on the finished branch: web 8,818 passed; backend
10,120 passed, 86 skipped and 3 failed (592 files), the three being the open
environment-move submodule timeouts 0248 and 0621, whose owning file then
passed alone twice; root/support, bridges and the protocol lockfile passed.
Both recurrences are recorded in their case files. The public surface was
checked mechanically: the same 69 public methods before and after.

Multi Review (`action-2623428a34b9d86c20fdd1e78cfe0ae5`, four reviewers on
`786d3c5e1`) reported no issues and no coverage gaps; three reviewers said
ready, one said "with-fixes" only because the review's own `mise run test`
failed two tests in unchanged files. Of those, `terminal-history.test.ts`
passed alone twice (6.6 s). `content-server.engines.test.ts` (`executable
document policy in firefox > popups, new-window links and top navigation reach
the sink zero times`, an unexpected `GET /favicon.ico` sink hit) also fails
alone, and fails the same way on the base commit `06297124`, so it predates
this work and is not caused by it.

## Assumptions and decisions

1. **Merge first, then extract.** Options: extract each collaborator out of the
   live six-layer chain, or first fold the six layers into one class
   mechanically and extract from that. Chosen: fold first. The layers had no
   overrides and no `super` calls, so concatenating them is behaviour-neutral,
   and every later extraction then deals with one `this` instead of abstract
   declarations spread over six files. Pros: each later diff is a pure move
   plus explicit wiring; no intermediate state needs new abstract members.
   Cons: one transient 11,500-line file in history; two eager field
   initializers had to move into the constructor because class fields run
   before parameter properties are assigned.
2. **One branch, one commit per step** instead of the plan's one PR per step.
   The coordinator delegated the whole file as one unit of work. Pros: one
   review of the complete structure, each step still bisectable. Cons: a larger
   PR to review than six small ones.
3. **Step 5 before the dispatcher.** The `queue*` parsers moved to a pure
   module before `PromptQueueDispatcher` was extracted, so the dispatcher's
   host did not need seven parser callbacks. Pros: a narrower host. Cons: the
   plan's order is not followed literally.
4. **Per-collaborator host objects built from arrow callbacks.** Options: pass
   the service itself (would need public or `protected` access everywhere), a
   single shared context object, or one explicit host interface per
   collaborator. Chosen: one host interface each, populated with arrow
   functions in the service constructor. Pros: every dependency is named and
   typed; a test that replaces a service method (`bridgeConnection`,
   `provider`) still reaches every collaborator because the arrows dispatch at
   call time; circular needs are plain callbacks. Cons: the projection and
   dispatcher hosts are still wide (12 and 13 members) because their code
   genuinely calls that much of the session layer.
5. **`scanTasks` / `trackScan` stay on the service.** The plan's table put
   `scanTasks` in `LaunchActivityReconciler`, but the projection settles, the
   interaction monitor, the queue drains and the launch scan all feed it, and
   shutdown drains it. Keeping it on the service avoids four collaborators
   depending on the reconciler for lifecycle. Cons: a small piece of state the
   plan assigned elsewhere.
6. **Scheduling is split by driver.** The keyed queue scheduler lives on the
   dispatcher (`startKeyedScheduling`) and the rollback interval on the
   reconciler (`startTimer`, which also runs the dispatcher's `queueScan`);
   `initialize` picks one. Alternative: one scheduling collaborator owning
   both. Pros: each owner keeps the timer that drives its own state. Cons: the
   choice between drivers stays in the service.
7. **`queueSessionObservedBusy` moved to the reconciler**, not the dispatcher:
   it reads only `observedSessionActivity` and the observation broker. The
   dispatcher asks through a host callback.
8. **`stopNotices` and `pushedSessionTitles` moved to the projection**, which
   was their only reader; Stop records a notice through `recordStopNotice`,
   which keeps the 256 bound.
9. **Registry access narrowed to single callbacks.** The projection only asked
   the registry for a bridge generation and the tracker only evicted a
   provider, so their hosts take `providerGeneration` and `evictProvider`
   instead of the whole `ProviderRegistry`. The reconciler still takes the
   registry: it prunes, observes dispatch counts and evicts.
10. **What "no test reads collaborator state through the service" means.**
    Tests obtain a collaborator with `collaborators(service)` (one cast, in
    `native-agent-service-test-collaborators.ts`) and read its state through
    that collaborator's `forTesting()` accessor; no service field exposes
    collaborator state. Two tests replace a private collaborator method to
    count calls (the rollback-timer test and the projected-row reuse test's
    `projectionPart` counter); they cast the collaborator, not the service.
    Alternative: construct collaborators directly in every test, which the
    end-to-end suites cannot do. Cons: `forTesting()` is a production-visible
    method that production code must not call.
11. **The service is not split further here.** It still holds the dispatch
    path, Stop/resume/fork, session controls, sign-in, mail injection and turn
    outcomes (3,880 lines), and `NativeAgentTranscriptProjection` is 5,303
    lines. The plan's target table and done criteria are met; further
    splitting is size work with no ordering risk, so it is a new low-rated
    file, [0057-native-agent-service-size.md](0057-native-agent-service-size.md),
    rather than an addition to this one.
12. **This file is kept, marked Finished, until the branch merges.** The plan
    said to delete it in the same change as the last layer; the delegation
    asked for these decisions to be recorded here for review. The README's
    Finished column covers exactly this interval. Delete the file and its index
    row after merge; the architecture doc already carries the durable content.

Assumptions:

- This is a behaviour-preserving refactor; the unchanged end-to-end suites are
  the oracle, and no live provider run is needed to qualify it.
- Collaborators are constructed in dependency order, and any callback that
  names a later collaborator runs only after the constructor returns.
- The public surface of `NativeAgentService` is unchanged: every public method
  either stayed or became a one-line delegate with the same signature.

## Constraints and rationale

- Background work is not tied to UI state: timers keep running with no
  renderer subscribed.
- Every queue and cache keeps its byte and count bounds (for example
  `toolDetailCacheBytes`, `projectionHistoryBytes`). Each bound moved with its
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
  `native-agent` folder slice, now unblocked by this work.
- [0057-native-agent-service-size.md](0057-native-agent-service-size.md): the
  size follow-up from decision 11.
- [`native-agent-service.md`](../../architecture/native-agent-service.md) and
  [`agent-engines.md`](../../architecture/agent-engines.md).

## Replaces

- `docs/2026-10-14/02-native-agent-service-collaborators.md`
