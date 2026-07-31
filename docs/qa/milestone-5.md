# Milestone 5 — Backend-owned looped-review controller

Status: Not started

Depends on: Milestones 3 and 4

Unblocks: Milestone 6

## Outcome

Move looped-review authority and advancement into a fenced backend service and
apply the same unattended interaction policy used by build pipelines. The
workflow continues without a mounted React tree and recovers after renderer or
backend restart.

## Scope

Primary files:

- `apps/backend/src/core/looped-review-service.ts` (new)
- `apps/backend/src/core/looped-review-service.test.ts` (new)
- `apps/backend/src/core/native-agent-service.ts`
- `apps/backend/src/core/commands.ts`
- `apps/backend/src/core/storage.ts`
- `packages/protocol/src/review-workflow.ts`
- `apps/web/src/components/review/LoopedReviewSupervisor.tsx`
- `apps/web/src/components/review/LoopedReviewTab.tsx`
- `apps/web/src/lib/structured-review-agent.ts`
- `apps/web/src/lib/looped-review-persistence.ts`
- `apps/web/src/stores/loopedReviewStore.ts`

## Backend controller checklist

- [ ] Introduce `LoopedReviewService` through the existing command-registry,
      storage, and `NativeAgentService` patterns.
- [ ] Port phase selection, prompt construction, provider-session reuse,
      structured-result polling, missing-result bounds, iteration transitions,
      pause/resume, cancellation, retry, and PR completion from React.
- [ ] Persist workflow state, provider session IDs, dispatch request IDs,
      structured-result wait state, failure context, and current interaction
      policy.
- [ ] Retain the controller lease/fence or replace it with an equivalent
      backend generation guard.
- [ ] Guarantee exactly one active controller generation.
- [ ] Persist each transition before dispatching downstream work that assumes
      the transition happened.
- [ ] Subscribe/monitor before calculating replay or recovery work.
- [ ] Never blindly redispatch a prompt after ambiguous acceptance.

## Unattended interaction checklist

- [ ] Mark every review phase session `unattended` with workflow, phase, and
      controller fence.
- [ ] Apply input `decline-and-continue` during preparation, review, fix,
      verification, and PR phases.
- [ ] Append a visible transcript/history record and increment the workflow
      auto-decline count.
- [ ] Apply authorization `deny-and-fail` in every phase.
- [ ] Persist failure context without full request content.
- [ ] Prove OpenCode cannot remain indefinitely busy on a pending question.
- [ ] Preserve the existing structured-result validation,
      target-branch-aware review semantics, iteration cap, and cancellation
      boundaries.

## Renderer conversion checklist

- [ ] Convert `LoopedReviewSupervisor` to hydration and command wiring while
      backend authority rolls out.
- [ ] Make `LoopedReviewTab` a snapshot-driven viewer/controller.
- [ ] Support start, pause, resume, retry, cancel, and open-provider-session
      commands without local phase authority.
- [ ] Rehydrate history, pending failure context, counts, controls, and current
      phase after remount.
- [ ] Remove the React controller only after backend parity and recovery tests
      pass.
- [ ] Keep a version gate so legacy running workflows are not silently adopted
      mid-phase.

## Recovery checklist

- [ ] Recover after renderer exit without pausing backend progress.
- [ ] Recover after backend restart from every persisted phase boundary.
- [ ] Reconcile provider session state before resuming work.
- [ ] Adopt only through a valid controller fence.
- [ ] Resolve or withdraw outstanding provider interactions according to their
      authoritative snapshot.
- [ ] Prove duplicate renderer clients cannot produce duplicate transitions.
- [ ] Prove expired lease takeover produces one controller and no duplicate
      provider dispatch.
- [ ] Preserve explicit paused/terminal state when safe automatic adoption is
      not possible.

## Required tests

- [ ] Review advances with its tab closed and another environment active.
- [ ] Review advances while no corresponding React tree is mounted.
- [ ] Renderer process exit and return rehydrates progressed or terminal state.
- [ ] Backend restart during each phase resumes or fails explicitly.
- [ ] Two clients competing for control produce one transition.
- [ ] Expired lease takeover is fenced and exact-once.
- [ ] Forced input requests decline, continue, record, and count in every
      representative phase/provider.
- [ ] Forced authorization requests deny and fail visibly.
- [ ] Provider idle without structured result respects existing bounded retry.
- [ ] OpenCode busy with a question cannot remain unbounded.
- [ ] Ambiguous dispatch, session adoption, max iteration, pause, cancel, and
      retry boundaries remain correct.

## Manual verification

- [ ] Start a looped review, close its tab, and work in another environment.
- [ ] Exit and reopen the desktop renderer while a phase is running.
- [ ] Verify backend progress and accurate rehydration.
- [ ] Force an input request and inspect its history/count after continuation.
- [ ] Force an authorization request and retry the explicit failure.
- [ ] Exercise pause/resume and cancellation around a provider restart.

## Commands

```bash
bun test apps/backend/src/core/looped-review-service.test.ts --parallel
bun test apps/backend/src/core/storage-looped-review-controller.test.ts --parallel
bun test apps/web/src/components/review --parallel
bun test apps/web/src/stores/loopedReviewStore.test.ts --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
```

## Exit criteria

- [ ] Backend state and fencing are authoritative for every review transition.
- [ ] Review progress does not require a mounted renderer.
- [ ] Every provider applies the same unattended input and authorization
      policy.
- [ ] Restart/takeover tests prove one controller, one dispatch, and one
      transition.
- [ ] React is snapshot-driven and contains no production phase-advancement
      path.
- [ ] Legacy workflow adoption is versioned and safe.

## Evidence and decisions

Record:

- backend state machine and persistence version;
- old-to-new controller responsibility mapping;
- restart/takeover fault-injection results;
- no-renderer timing evidence;
- per-provider input/authorization outcomes;
- focused test and typecheck output.

No evidence recorded yet.
