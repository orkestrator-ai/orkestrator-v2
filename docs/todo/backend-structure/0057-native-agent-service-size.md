# Native agent service size

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Session-control collaborator**: move Stop, resume, fork, actions, controls and sign-in out of `NativeAgentService`. Status: done (`NativeAgentSessionOperations`; steer stays for task 2).
2. **Dispatch and mail injection collaborator**: move the dispatch path and mail injection out only if the lease and fence ordering stays in one place; includes the open question about sharing a collaborator with Stop. Status: open.
3. **Split the transcript projection by read model**: progressive reads apart from the legacy full projection, with shared caches under one owner. Status: open.
4. **Move the projection's free helpers into a module**. Status: done (`native-agent-projection-helpers.ts`).
5. **Qualification per split**: direct tests for each new class, `forTesting()` reads moved with the state, end-to-end suites unchanged. Status: done for tasks 1 and 4; open for tasks 2 and 3.

### 1. Session-control collaborator

**Problem.** `apps/backend/src/core/native-agent-service.ts` is 4,276 lines, over twice the 2,000-line guideline, and still growing. Anyone changing one session control reads the whole service.

**Context.** Opened from [0010](0010-native-agent-service-collaborators.md) decision 11, which removed the `extends` chain and moved the stateful clusters into collaborators but left the stateless session work. Size and readability only; no behaviour or ordering risk.

**Investigation.** The service has grown by 396 lines since this file was written (3,880), across 25 commits, mostly mail steering (#1312, #1310), interaction holds (#1273) and MCP evidence (#1251). The session-control block is contiguous: `stopProjectionSession` at `native-agent-service.ts:1879` through `holdProjectionInteraction` at `:2640` and its helpers to about `:2722` (Stop, background-task stop, suggested prompts, resumable sessions, resume, fork at `:2161`, actions at `:2199`, MCP actions, sign-in at `:2265` to `:2311`, steer at `:2312` to `:2491`, controls at `:2492`, interactions), about 840 lines. It already reaches its fences through the dispatcher (`this.promptQueues.withSessionMutationIntent` at `:1882`, `fenceTurnInterrupt` at about `:1916`), so it holds no fence state itself. It calls `resolveProjectionSession` (`:2680`), `provider`, `bridgeConnection` and `dispatchIntent`, which a host object would have to expose; the projection host already exposes several of these (`native-agent-transcript-projection.ts:704` to `:731`).

**Decisions.**

- **How wide should the session-control collaborator be?**
  - **Stop, resume, fork, actions, controls and interactions in one collaborator; steer and sign-in left for later (recommended).**
    - Pros: about 600 lines out in one contiguous move; steer depends on the dispatch path (task 2) and sign-in on the provider registry, so leaving them avoids widening the host.
    - Cons: the service stays at about 3,650 lines after this step alone.
  - **Everything in the 1,879 to 2,722 block, steer and sign-in included.**
    - Pros: one move; about 840 lines out.
    - Cons: the host has to expose the persisted-steer dispatch helpers, making it as wide as the 12- and 13-member hosts 0010 already called wide.
- **Should public methods stay as one-line delegates on the service?**
  - **Yes, as 0010 did (recommended).**
    - Pros: `commands-registry-native.ts` and the other callers do not change; the public surface stays checkable by count.
    - Cons: about 20 more one-line delegates in the service file.
  - **Expose the collaborator on `CommandContext` and move callers.**
    - Pros: no delegates.
    - Cons: widens the change to every caller and the public-API fakes for a size-only gain.

### 2. Dispatch and mail injection collaborator

**Problem.** The dispatch path (`dispatchIntent` at `native-agent-service.ts:1485` through `retryRecoverableDispatch` ending about `:1878`, and `dispatchPrompt`/`dispatchAdmittedPrompt` at `:3346` to `:3733`) and mail injection (`mailInjectPresence` at `:2998` to `reconcileMailSteer` ending `:3345`) are together about 1,300 lines.

**Context.** The file allows the move only if `dispatchAdmittedPrompt` keeps its lease and fence ordering in one place, and asks (open question) whether dispatch and Stop should share one collaborator because both take the session work fence and the interrupt fences in a fixed order.

**Investigation.** `dispatchAdmittedPrompt` alone is about 360 lines. Its ordering is: environment agent-work fence (`dispatchPromptInternal`, `:3361`), the session mutation fence on the dispatcher (`:3363`), then `storage.dispatchNativeAgentPromptOnce` (the storage lease held across provider I/O), then the observation dispatch fence (`this.observations.beginDispatch`). Stop takes `withSessionMutationIntent` and `fenceTurnInterrupt`, both on `NativeAgentPromptQueueDispatcher`. So the fence state and its order already live in one collaborator (the dispatcher); what remains on the service is the call sequence, not shared state. Mail injection grew most recently (`steerMailInject` at `:3234`, `reconcileMailSteer` at `:3313`, from #1312) and calls `dispatchPromptInternal` with `mailInject = true`.

**Decisions.**

- **Should dispatch and Stop share one collaborator (the open question)?**
  - **No: separate collaborators, both taking fences from the dispatcher (recommended).**
    - Pros: the fence state and order already live in `NativeAgentPromptQueueDispatcher`; each new class stays one responsibility; it answers the open question with evidence rather than leaving it open.
    - Cons: the fixed fence order is a convention between two callers rather than one call site; a comment at each call must name it.
  - **One "turn lifecycle" collaborator for dispatch and Stop.**
    - Pros: the acquire order is visible in one file.
    - Cons: about 1,700 lines in one class, recreating the size problem one level down.
- **Move dispatch and mail injection together or separately?**
  - **Together, as one dispatch collaborator (recommended).**
    - Pros: mail injection is a dispatch variant (`mailInject` flag on the same internal path); splitting them would put a private method on a host.
    - Cons: about 1,300 lines; still under the limit but large.
  - **Mail injection first, dispatch kept on the service.**
    - Pros: smaller, lower-risk first step; mail injection is the fastest-growing area.
    - Cons: `dispatchPromptInternal` becomes a host callback, which spreads the ordering across two files, the outcome the file warns against.
  - **Record why dispatch stays and do not move it.**
    - Pros: no risk to the at-most-once path.
    - Cons: the service stays over the limit even after task 1.

### 3. Split the transcript projection by read model

**Problem.** `apps/backend/src/core/native-agent-transcript-projection.ts` is 5,589 lines (was 5,303), almost three times the guideline; the class alone spans `:749` to `:5553`.

**Context.** The file proposes two read models sharing the tool-detail and projected-message caches through one owner.

**Investigation.** The progressive reads run from `progressiveKey` (`:1824`) to `getDiscoveryUpdate` (ending about `:3828`), about 2,000 lines. The legacy full projection (`getProjectionUpdate` `:3829`, `getMessagePage` `:3924`, direct pages, `refreshProjection` `:4712`, `refreshProjectionOnce` `:4764`, about 630 lines on its own, through `commitProjection` `:5456`) is about 1,400 lines. Shared between them: the tool-detail cache (`:782`, methods `:1079` to `:1229`), `projectionPart`/`projectedMessage`/`projectionMessages` (`:1230` to `:1622`) over `ProjectedMessageCache` (`:877`), and `projectionComposer` (`:4325` to `:4591`). The legacy projection is still live: `getProjection` is called from `commands-registry-native.ts:174`, `index.ts:983` and `:1216`, and `web-annotation-dispatch.ts:1274`; `getProjectionUpdate` from `commands-registry-native.ts:304`. The test hook `forTesting()` is at `:954`.

**Decisions.**

- **Who owns the shared caches?**
  - **A small `ProjectionParts` owner (tool details, projected messages, composer) that both read models take (recommended).**
    - Pros: each read model is a plain consumer; the byte bounds stay with one owner, as the 0010 invariant requires.
    - Cons: three classes instead of two; `forTesting()` has to be split across them.
  - **The progressive read model owns them and the legacy model reaches them through a host callback.**
    - Pros: two classes, as the file proposed.
    - Cons: the legacy model depends on the progressive one, and the bound owner is the larger, faster-changing class.
- **Should the legacy full projection be retired instead of split?**
  - **Split now; retiring it is a separate change (recommended).**
    - Pros: it has live callers (the commands above and the web workflows client), so retiring it needs its own compatibility analysis.
    - Cons: about 1,400 lines kept that may later be deleted.
  - **Open a todo to retire it first and skip this split.**
    - Pros: deletes rather than moves code.
    - Cons: blocks this low-rated file on an unscoped compatibility change.

### 4. Move the projection's free helpers into a module

**Problem.** Module-level helpers and constants occupy `native-agent-transcript-projection.ts:206` to `:748`, about 540 lines, before the class starts.

**Context.** Item 4 names `mergeContextUsageTurns` and `attachProgressToToolRows`.

**Investigation.** Both still live here (`:335` and `:473`), with `mergeNativeAgentQueueItems` (`:373`) and `withProviderContextWindow` (`:419`), all exported, plus private image, usage, progress and discovery-key helpers. Sibling helper modules already exist from earlier work (`native-agent-projection-entries.ts`, `native-agent-direct-history.ts`, `native-agent-display-tails.ts`), so there is precedent for the target.

**Decisions.**

- **Where do the helpers go?**
  - **A new `native-agent-projection-helpers.ts`, re-exported from the projection module for existing importers (recommended).**
    - Pros: purely mechanical; can land first and independently of task 3; no caller changes.
    - Cons: one more module in an already crowded `core/` (see [0012](0012-backend-core-domain-folders.md)).
  - **Fold them into the existing `native-agent-projection-entries.ts`.**
    - Pros: no new file.
    - Cons: that module has its own subject; mixing image and usage helpers in it blurs it.
- **Order relative to task 3?**
  - **Do task 4 first (recommended).**
    - Pros: removes 540 lines from the file before the harder split and shrinks its diff.
    - Cons: two changes to the same file in sequence.
  - **Do it within task 3.**
    - Pros: one change.
    - Cons: the read-model split diff becomes harder to review.

### 5. Qualification per split

**Problem.** Each split must preserve behaviour.

**Context.** The file's rule: direct tests for each new class through its public interface, `forTesting()` reads moved with their state, and the `native-agent-service-*.test.ts` suites left unchanged as the oracle, as 0010 did (891 to 935 tests, all passing).

**Investigation.** The oracle suites and `native-agent-transcript-projection.test.ts` exist; `native-agent-service-test-collaborators.ts` is where `collaborators(service)` would gain the new classes.

**Decisions.**

- **One branch for all splits, or one per split?**
  - **One change per task, in the order 4, 3, 1, 2 (recommended).**
    - Pros: each diff is a reviewable pure move; the riskiest (dispatch) goes last, after the pattern is settled.
    - Cons: four review cycles for size-only work.
  - **One branch, one commit per step, as 0010 did.**
    - Pros: one review of the final structure, still bisectable.
    - Cons: a very large diff against two of the most frequently changed backend files, inviting merge conflicts with feature work.

## Assumptions and decisions

Tasks 1 and 4 done 2026-10-28 on `todo-0057-native-agent-service-split`.
`native-agent-service.ts` went from 4,420 to 3,868 lines and
`native-agent-transcript-projection.ts` from 5,722 to 5,255. Both moves are
verbatim: the moved method bodies match the originals token for token apart
from `this.` becoming `this.host.`.

### Task 1: collaborator width (sign-in included, steer left)

Took the recommended scope (Stop, background-task stop, suggested prompts,
the resume list and archive, resume, fork, session and MCP actions, controls
and interactions) but **also moved sign-in** (`readProjectionAuthStatus`,
`beginProjectionSignIn`, `cancelProjectionSignIn`,
`signOutProjectionProvider`). The recommendation left sign-in because it
"depends on the provider registry", but the code shows it needs only
`provider` (which resume and the resume list already need) and
`observeProvider`: one more host callback, not the registry. The task title
and outstanding-work item 1 both name sign-in.

Steer stays on the service, as recommended: `steerQueuedPrompt`,
`performProjectionSteer` and `dispatchPersistedSteer` take the dispatcher's
mutation fence around `storage.dispatchNativeAgentSteerOnce`, and the prompt
queue reaches `dispatchQueuedAsyncQuestionAnswer` through them, so they belong
with task 2. The `steer` session action reaches it through one host callback.

### Task 1: one-line delegates on the service

Recommended option taken. The 17 public methods stay on `NativeAgentService`
as one-line delegates, so `commands-registry-native.ts`, the public-API fakes
and the design host (which calls service methods by name) are unchanged.

### Task 1: name and file

`NativeAgentSessionOperations` in `native-agent-session-operations.ts`.
`native-agent-session-controls.ts` already exists (the composer control
merge), and "controls" here means composer controls, so a
`NativeAgentSessionControl` beside it would read as the same subject.

### Task 1: host shape

The host has 15 members: six shared references (`storage`, `options`,
`projections`, `promptQueues`, `interactions`, optional `permissionRules`) and
nine callbacks (`now`, `assertProjectionInput`, `resolveProjectionSession`,
`provider`, `observeProvider`, `trustedSessionInput`, `adoptSession`,
`getProjection`, `performProjectionSteer`). The callbacks are arrow functions
over the service, as 0010 wires every host, so service suites that patch a
service seam (`provider`, `trustedSessionInput`, `observeBridgeConnection`)
still reach the moved code unchanged. `getProjection` stays a callback rather
than being inlined so the move stays verbatim. Stop holds no fence state: it
takes `withSessionMutationIntent`, `fenceTurnInterrupt` and
`releaseTurnInterrupt` from the dispatcher, as before.

### Task 4: target module and what moves

Recommended option taken: `native-agent-projection-helpers.ts`, with the
projection module re-exporting the four helpers existing importers use
(`attachProgressToToolRows`, `mergeContextUsageTurns`,
`mergeNativeAgentQueueItems`, `withProviderContextWindow`), so no importer
changed. The module-level functions and constants moved; the class-private
type declarations (`ProjectedProgressiveTranscript`,
`ProgressiveTranscriptEntry`, `ProgressiveHydrationEntry`,
`ProviderTranscriptRow`, `ProjectedTranscriptMessage`,
`PromptPresentationKind`) stay with the class, because they describe its
cache state and should move with whichever read model owns that state in
task 3.

### Tasks 4 and 1: order and branching

The recommended order is one change per task, 4, 3, 1, 2. This delegation
asked for tasks 1 and 4 together, so they are two commits on one branch
(task 4 first, then task 1), each reviewable and bisectable alone. Doing task
1 before task 3 is safe: task 1 touches only the service, and task 3 only
the projection.

### Task 5: qualification

`native-agent-session-operations.test.ts` drives the new class through its
public interface with a fake host (Stop ordering and its abort ladder,
resume and the replaced-session close, the resume list, fork, actions,
sign-in, controls, interactions). `native-agent-projection-helpers.test.ts`
covers the helpers module and checks the re-exports are the same functions.
The new class owns no state, so no `forTesting()` reads moved;
`collaborators(service)` lists it as `sessionOperations`. The
`native-agent-service-*.test.ts` oracle suites are unchanged.

Opened 2026-10-23 from
[0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md)
(decision 11), which removed the six-layer `extends` chain but left two files
well over the repository's 2,000-line guideline.

## Current state

- `apps/backend/src/core/native-agent-service.ts` is 3,880 lines. Its state
  now lives in collaborators; what remains is session work with little state
  of its own:
  - trusted session input, `ensureSession` / `adoptSession` /
    `inspectSession`, bridge start and peek (about 900 lines);
  - the dispatch path: `dispatchIntent`, `attemptDispatch`,
    `dispatchAdmittedPrompt` (which holds the storage lease across provider
    I/O), the parked-dispatch settles, retry and discard (about 900 lines);
  - session controls: Stop, resume, fork, session and MCP actions, steer,
    controls, interactions, sign-in (about 1,000 lines);
  - mail injection and turn outcomes, including `turnOutcomeAttempts`
    (about 600 lines);
  - provider teardown, moves and MCP evidence (about 400 lines).
- `apps/backend/src/core/native-agent-transcript-projection.ts` is 5,303 lines:
  module helpers (about 450 lines), the legacy full projection with sync and
  history (`refreshProjectionOnce` alone is about 600), the progressive
  transcript/state/discovery reads, tool details and display tails.
- Both are covered end to end by the `native-agent-service-*.test.ts` suites
  and directly by `native-agent-transcript-projection.test.ts`.

## Outstanding work

### Code

1. Done: split the session-control operations (Stop, resume, fork, actions,
   controls, sign-in) out of `NativeAgentService` into a collaborator taking a
   host, as 0010 did for the stateful clusters. Keep the public methods as
   delegates.
2. Move the dispatch path and mail injection into their own collaborator only
   if it can keep `dispatchAdmittedPrompt`'s lease and fence ordering in one
   place; otherwise record why it stays.
3. Split `NativeAgentTranscriptProjection` along its two read models: the
   progressive transcript/state/discovery reads and the legacy full
   projection with sync and history, sharing the tool-detail and
   projected-message caches through one owner.
4. Done: move the projection module's free helpers
   (`mergeContextUsageTurns`, `attachProgressToToolRows` and the rest) into
   their own module.

### Qualification

Each split adds direct tests for the new class through its public interface,
moves any `forTesting()` reads with the state, and leaves the end-to-end
service suites unchanged as the oracle.

## Constraints and rationale

- The constraints in 0010 still apply: bounds move with their state, the
  storage lease is held across provider I/O during dispatch, close never
  deletes a provider session, background work is not tied to UI state.
- No `extends` layers: `tests/unit/inheritance-chains.test.ts` rejects them.
- This is size and readability work; nothing here changes behaviour or removes
  an ordering risk, which is why it rates low.

## Open questions

- Whether `dispatchAdmittedPrompt` and the Stop path should share one
  collaborator, since both take the session work fence and the interrupt
  fences in a fixed order.

## Related

- [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md)
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md)
- [`native-agent-service.md`](../../architecture/native-agent-service.md)

## Replaces

Nothing; new work.
