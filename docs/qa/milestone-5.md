# Milestone 5 — Backend-owned looped-review controller

Status: Implemented (automated acceptance complete; desktop manual checks pending)

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
- `apps/web/src/components/review/LoopedReviewTab.tsx`
- `apps/web/src/lib/looped-review-persistence.ts`
- `apps/web/src/App.tsx` (the single renderer-side hydration pass)
- `apps/web/src/stores/loopedReviewStore.ts`

## Backend controller checklist

- [x] Introduce `LoopedReviewService` through the existing command-registry,
      storage, and `NativeAgentService` patterns.
- [x] Port phase selection, prompt construction, provider-session reuse,
      structured-result polling, missing-result bounds, iteration transitions,
      pause/resume, cancellation, retry, and PR completion from React.
- [x] Persist workflow state, provider session IDs, dispatch request IDs,
      structured-result wait state, failure context, and current interaction
      policy.
- [x] Retain the controller lease/fence or replace it with an equivalent
      backend generation guard.
- [x] Guarantee exactly one active controller generation.
- [x] Persist each transition before dispatching downstream work that assumes
      the transition happened.
- [x] Subscribe/monitor before calculating replay or recovery work.
- [x] Never blindly redispatch a prompt after ambiguous acceptance.

## Unattended interaction checklist

- [x] Mark every review phase session `unattended` with workflow, phase, and
      controller fence.
- [x] Apply input `decline-and-continue` during preparation, review, fix,
      verification, and PR phases.
- [x] Append a visible transcript/history record and increment the workflow
      auto-decline count.
- [x] Apply authorization `deny-and-fail` in every phase.
- [x] Persist failure context without full request content.
- [x] Prove OpenCode cannot remain indefinitely busy on a pending question.
- [x] Preserve the existing structured-result validation,
      target-branch-aware review semantics, iteration cap, and cancellation
      boundaries.

## Renderer conversion checklist

- [x] Remove `LoopedReviewSupervisor` entirely. It duplicated the hydration
      effect in `App.tsx`, and its `workflowCount > 0` mount gate made the
      cold-start recovery it existed for structurally unreachable.
- [x] Make `LoopedReviewTab` a snapshot-driven viewer/controller.
- [x] Support start, pause, resume, retry, cancel, and open-provider-session
      commands without local phase authority.
- [x] Rehydrate history, pending failure context, counts, controls, and current
      phase after remount.
- [x] Remove the React controller only after backend parity and recovery tests
      pass.
- [x] Keep a version gate so legacy running workflows are not silently adopted
      mid-phase.

## Recovery checklist

- [x] Recover after renderer exit without pausing backend progress.
- [x] Recover after backend restart from every persisted phase boundary.
- [x] Reconcile provider session state before resuming work.
- [x] Adopt only through a valid controller fence.
- [x] Resolve or withdraw outstanding provider interactions according to their
      authoritative snapshot.
- [x] Prove duplicate renderer clients cannot produce duplicate transitions.
- [x] Prove expired lease takeover produces one controller and no duplicate
      provider dispatch.
- [x] Preserve explicit paused/terminal state when safe automatic adoption is
      not possible.

## Required tests

- [x] Review advances with its tab closed and another environment active.
- [x] Review advances while no corresponding React tree is mounted.
- [x] Renderer process exit and return rehydrates progressed or terminal state.
- [x] Backend restart during each phase resumes or fails explicitly.
- [x] Two clients competing for control never dispatch the same request twice.
      Which controller wins a given step is genuinely unspecified — it depends
      on who reaches the lease claim first — so the test asserts the fencing
      invariant across repeated racing steps rather than an exact dispatch count
      from one schedule.
- [x] Expired lease takeover is fenced and exact-once.
- [x] Only one looped review may run per environment at a time.
- [x] A version-1 workflow interrupted mid-dispatch is quarantined into `failed`
      rather than replayed, and stays retryable and cancellable.
- [x] Forced input requests decline, continue, record, and count in every
      representative phase/provider.
- [x] Forced authorization requests deny and fail visibly.
- [x] Provider idle without structured result respects existing bounded retry.
- [x] OpenCode busy with a question cannot remain unbounded.
- [x] Ambiguous dispatch, session adoption, max iteration, pause, cancel, and
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
bun test packages/protocol/src/review-workflow.test.ts --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd packages/protocol build
```

## Exit criteria

- [x] Backend state and fencing are authoritative for every review transition.
- [x] Review progress does not require a mounted renderer.
- [x] Every provider applies the same unattended input and authorization
      policy.
- [x] Restart/takeover tests prove one controller, one dispatch, and one
      transition.
- [x] React is snapshot-driven and contains no production phase-advancement
      path.
- [x] Legacy workflow adoption is versioned and safe.

## Evidence and decisions

Recorded 2026-08-02:

- Backend state machine and persistence version: version 2 is defined in
  `packages/protocol/src/review-workflow.ts`. `LoopedReviewService` owns
  preparation, discovery, reconciliation, fixing, PR creation, structured-result
  waits, interaction resolution, and terminal transitions. Storage envelopes use
  compare-and-swap revisions plus a renewable controller lease token.
- Responsibility mapping: `App.tsx` performs the one renderer-side hydration
  pass per environment; `LoopedReviewTab` only renders snapshots, invokes
  lifecycle commands, and re-reads the authoritative record when it becomes
  visible again; `loopedReviewStore` is a read-through projection with no phase
  mutation methods; renderer persistence is hydration-only. Backend prompts,
  parsers, provider admission, session reuse, dispatch, polling, and transitions
  live in `apps/backend/src/core/looped-review-*.ts`.
- Restart/takeover injection: the service test restarts the controller after each
  persisted boundary through completion, races two controllers, expires a
  2-second lease, and reconciles an ambiguously accepted request. Each case
  records one request ID and no duplicate send.
- No-renderer evidence: the headless service reaches a verified PR using only
  `StorageService`, a provider adapter, and backend command invocations. The
  React supervisor renders no controller tree. Resource-event and remount tests
  install progressed/terminal backend revisions.
- Interaction outcomes: preparation, discovery, fix, and PR questions are
  auto-declined, recorded, and counted. Claude, Codex, and OpenCode use the same
  unattended policy. OpenCode transitions out of blocked after its question is
  declined. Authorization is denied, aborts the provider session, and persists
  only request/session/provider/kind metadata in failure context.
- Focused verification: the looped-review service, storage-fence, review
  component, renderer store/persistence, prompt-contract, protocol-contract and
  command/state-sync suites all pass, as do the web, backend, desktop and
  protocol typechecks. The integrated `bun run test` passes every workspace,
  root, bridge, protocol-lockfile and iOS group.
- Counts in this document are deliberately not pinned to exact numbers: they
  went stale within a single change, and a test count is not evidence of a
  property holding. The exit criteria above name the properties instead, and
  each is asserted by a named test.
- The renderer no longer carries its own copy of the workflow contract. Every
  type and guard is re-exported from `@orkestrator/protocol/review-workflow`,
  so a snapshot the backend accepts cannot be silently rejected — and therefore
  dropped from the UI — by a divergent renderer guard.
- Manual desktop checks remain intentionally unchecked above; they require live
  provider credentials and an Electron renderer and were not simulated.
