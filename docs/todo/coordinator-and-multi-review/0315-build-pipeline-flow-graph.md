# Build pipeline flow graph follow-ups

Checked against the branch that introduced the pipeline flow graph
(2026-10-26). The design is in
[build-pipeline-view.md](../../architecture/build-pipeline-view.md).

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

None of the seven items is done. Items 1 to 5 need a live provider (and item 3
a remote leaf node); items 6 and 7 are code. Later work changed the graph
around them (live usage, #1353; rewinds, #1354; validation and skip controls,
#1364; code rewind and package-only restart, #1376) but closed none of them.

### Tasks

1. **A real pipeline end to end**: a fan-out pipeline on a `dev:test` profile through review, a failed verification, Fix and Ship. Status: open (needs a live provider).
2. **Retry one reviewer on a real provider**: fail one panel slot, retry it from its node, check the consolidation. Status: open (needs a live provider).
3. **Remote node**: node state, transcripts, the PR node, double-click and the review-pass tab for a pipeline on a remote leaf. Status: open (needs a remote leaf node).
4. **Session tabs from the graph**: a running stage's session opened by double-click is read-mostly, per provider. Status: open (needs a live provider).
5. **Live token usage per provider**: the running node's count appears within one persist interval on every harness. Status: open (needs all five providers).
6. **Validation history**: older Prepare nodes keep a summary of their own validation run. Status: open.
7. **Retry a reviewer after consolidation**: a per-reviewer rerun once the pass has consolidated. Status: open.

### 1. A real pipeline end to end

**Problem.** The graph has only fixture evidence. Nobody has watched it follow a real pipeline as passes start, fail and repeat.

**Context.** `e2e/PipelineFlow.spec.ts` covers the line, fan-out, unrolled passes, selection, the PR node and reload against fixture data (`/pipeline-flow?scenario=…`). The projection is `pipelineFlowModel` in `apps/web/src/components/build-pipeline/pipeline-flow.ts`.

**Investigation.** The file's description still holds. Two things a live run now also exercises: Verify became a quick evidence-based diff review in #1393 (`f4e14254`), so a failed verification depends more on the recorded validation than before; and a forward pass replaces the pipeline's `validationRun`, so only the newest Prepare node shows checks (task 6), which the run should expect rather than report as a fault.

**Decisions.**

- **Which providers run it?**
  - **Cursor for every stage and a two-reviewer panel of Cursor and Pi (recommended).** These are the credentials the user approved for disposable `dev:test` profiles (the saved Cursor key as `CURSOR_API_KEY`, a copied Pi login), so the run needs no interactive login.
    - Pros: repeatable without the user present; exercises fan-out and consolidation.
    - Cons: Cursor and Pi may report usage only at turn end, so the live token row is not tested here (task 5 does that).
  - **Claude and Codex after `mise run dev:login`.**
    - Pros: the two bridges that report usage mid-turn.
    - Cons: needs the user to log the profile in; uses their subscription.
- **How to get a failed verification reliably?**
  - **A throwaway repository with a failing test the ticket's acceptance criterion names, and `maxIterations` of at least 2 (recommended).** Verify reads the recorded validation, so a red check fails it, and Fix has a concrete target.
    - Pros: fails for a reason the graph and inspector can show; close to normal use.
    - Cons: the Build may fix the test first time; then restart Verify after breaking the test by hand, and record that the failure was induced.
  - **Hope the agent misses a criterion.**
    - Pros: no setup.
    - Cons: not repeatable.
- **What counts as a pass?** Every point the item lists holds: the line grows rightwards as each pass starts, the faded steps ahead match what then runs, the PR node shows the PR and its checks after Ship, and leaving the tab and coming back keeps the selection rules and transcript. Record the profile, providers and pipeline ID in this file.

### 2. Retry one reviewer on a real provider

**Problem.** `retry_build_pipeline_reviewer` is covered by service tests and a fixture, never by a real provider failure.

**Context.** The backend path is `retryReviewer` (`apps/backend/src/core/build-pipeline-service-lifecycle.ts:1643`) and `prepareReviewerRetry` (`apps/backend/src/core/build-pipeline-review-fanout.ts:341`). Service coverage is `apps/backend/src/core/build-pipeline-review-fanout-retry.test.ts`.

**Investigation.** `prepareReviewerRetry` refuses unless the reviewer has `status: "failed"` and the pass has no `report` yet (`build-pipeline-review-fanout.ts:347-352`). A started consolidation is abandoned and its session superseded (`:353-381`); cancelled peers are requeued with the retried one (`:384-392`). The retry gets the session key suffix `…:attempt-2`.

**Decisions.**

- **How to make one reviewer fail so that its retry can succeed?**
  - **Kill that reviewer's provider process mid-turn (recommended).**
    - Pros: the slot's configuration stays valid, so the retry can succeed and the panel can consolidate, which is what the item checks; a mid-turn failure is also closer to a real outage.
    - Cons: timing-dependent; the kill must hit only that reviewer's process; whether the fan-out marks the reviewer failed or reconnects it on its own was not checked.
  - **A bad model ID on one panel slot, as the item says.**
    - Pros: deterministic; fails before any tokens are spent.
    - Cons: `resetReviewerForRetry` (`build-pipeline-review-fanout.ts:1408`) keeps the slot's model, so the retry fails the same way and the consolidation is never reached. It still checks the failed node and the attempt count.
- **What counts as a pass?** The panel consolidates with the retried report, the failed attempt stays readable under its own key, and the inspector counts the earlier attempt.

### 3. Remote node

**Problem.** A pipeline running on a remote leaf has only one fixture check.

**Context.** The PR node reads `usePullRequest({ environmentId })` (`apps/web/src/components/build-pipeline/PipelinePullRequestView.tsx:22`), which for a remote environment depends on the PR monitor mirror. Federation is described in [federation.md](../../architecture/federation.md).

**Investigation.** `e2e/PipelineFlow.spec.ts:514-546` ("remote review passes retain their provider session and route controls to the workspace") opens a reviewer session and retries a reviewer with `remote=1` fixture data. Node state from a live leaf, transcripts across the route, the PR mirror and the review-pass tab are not covered.

**Decisions.**

- **Which setup?**
  - **A second machine as the leaf, reached from a `dev:test` command node (recommended).**
    - Pros: the real route, latency and PR mirror.
    - Cons: needs a second host with Orkestrator and provider credentials.
  - **Two profiles on one host.**
    - Pros: one machine.
    - Cons: whether federation accepts a leaf on the same host was not checked; a loopback route hides latency and reconnect behaviour.
- **What counts as a pass?** Node states and transcripts match the leaf's own view, the PR node shows the PR and checks once Ship has run, a double click opens the session on the leaf, and the review-pass tab opens.

### 4. Session tabs from the graph

**Problem.** A double click opens a running stage's provider session in a tab of its own. Nothing yet shows, per provider, that a message typed there cannot be taken for the pipeline's own turn.

**Context.** `pipelineSessionTabOptions` (`apps/web/src/components/build-pipeline/PipelineFlowView.tsx:106-127`) opens a native tab with `resumeSessionId`, `hideStructuredOutput: true` and `requireExistingResumeSession: true`.

**Investigation.** `requireExistingResumeSession` only stops a missing session opening as an empty one. Nothing else marks the opened tab as owned by the pipeline: there is no read-only flag, and no code names the `build-pipeline-session:` tab ID outside `PipelineFlowView.tsx:113`. So "read-mostly" is whatever each provider's native tab does when it resumes a session that is mid-turn; it is unverified.

**Decisions.**

- **What counts as a pass?**
  - **Per provider (Claude, Codex, OpenCode, Cursor, Pi), open a running Build's session, type a message, and check the pipeline's stage still completes on its own result (recommended).**
    - Pros: tests the actual risk, not just that the tab opens.
    - Cons: five live runs; a provider that queues the message may still change the stage's outcome.
  - **Only check the tab opens and shows the transcript.**
    - Pros: cheap.
    - Cons: misses the risk the item names.
- **If a typed message is taken as the pipeline's turn?** Record the provider here; the fix (for example disabling the composer while the pipeline owns the session) is new work and goes in a new todo file.

### 5. Live token usage per provider

**Problem.** Every stage session records `tokenCount` while it runs (#1353, `0ba39587`), but only Claude and Codex are known to report usage mid-turn.

**Context.** `recordPipelineSessionUsage` (`apps/backend/src/core/build-pipeline-session-usage.ts:55-80`) copies `contextUsage.sessionTokens`, or meters from the transcript the pass already read (OpenCode). It is called from the supervisor (`build-pipeline-service-supervisor.ts:612`, `:619`, `:706`, `:762`) and the fan-out (`build-pipeline-review-fanout.ts:1061`). The persist interval is `DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS = 5_000` (`build-pipeline-service-helpers.ts:533`).

**Investigation.** The count only grows, and a failed meter never fails the stage. A running node without a count shows "—" (`e2e/PipelineFlow.spec.ts:607`). The Cursor, Pi and ACP bridges all write `sessionTokens` somewhere; whether they do so mid-turn is what the run decides.

**Decisions.**

- **How to cover the stages?**
  - **One fan-out pipeline per harness, that harness on every stage, with two reviewers (recommended).** That runs Build, reviewers, Consolidation, Verify and Ship, plus Fix or Address when they happen.
    - Pros: one run per provider covers every metered stage kind.
    - Cons: five full pipelines; Claude and Codex need `dev:login`, OpenCode its own credentials.
  - **A single-review pipeline per harness.**
    - Pros: cheaper.
    - Cons: no Consolidation, which the item lists.
- **What counts as a pass?** The running node shows a count within 5 s of the provider's first usage report, and the final count after the turn. A provider that reports only at turn end passes if it shows "—" while running and the count afterwards; note which ones do.

### 6. Validation history

**Problem.** The record keeps only the latest validation run, so only the newest Prepare node shows its checks.

**Context.** `BuildPipeline.validationRun` is "this iteration's" run (`packages/protocol/src/build-pipeline.ts:1189-1190`). The graph attaches it to the last Prepare node (`apps/web/src/components/build-pipeline/pipeline-flow.ts:83-84`, `:757-790`).

**Investigation.** Still open for forward passes. A new plan replaces the run (`build-pipeline-service-supervisor.ts:1082`), and starting a dedicated package preparation deletes it (`:1377-1382`). Rewinds are already covered: `PipelineRewind.validationRun` keeps a run a rewind invalidated (`packages/protocol/src/build-pipeline.ts:210-211`), and the graph shows it on the previous attempt (`pipeline-flow.ts:665-690`), bounded by `MAX_PIPELINE_REWINDS = 50` (`build-pipeline.ts:298`). A `ReviewValidationResult` keeps its output by path (`stdoutPath`, `stderrPath`), not inline (`packages/protocol/src/review-validation.ts:18-37`); whether an older run's output files survive the next run was not checked.

**Decisions.**

- **What to keep per older run?**
  - **A bounded summary per run on the pipeline record: run ID, iteration, status, start and end, and per-command name, status, exit code and duration, newest N runs (recommended).**
    - Pros: small; enough for the node's chips and a read-only Tests view; does not depend on output files outliving their run.
    - Cons: no stdout or stderr for older runs; one more additive record field.
  - **Keep whole runs per round, like `roundReviewReports`, under a byte budget.**
    - Pros: the full Tests view for every pass.
    - Cons: output paths may point at files that are gone; larger hot snapshot.
  - **Do nothing; the newest checks are what matter.**
    - Pros: no change.
    - Cons: older Prepare nodes stay blank, which reads as "never validated".

### 7. Retry a reviewer after consolidation

**Problem.** Once a pass has consolidated, one reviewer cannot be rerun on its own; the stage restart reruns the whole panel.

**Context.** `prepareReviewerRetry` throws "The review has been consolidated; restart the review stage to rerun it" when `state.report` is set (`apps/backend/src/core/build-pipeline-review-fanout.ts:347-349`). `reviewFanout` is cleared when the review stage finishes (`packages/protocol/src/build-pipeline.ts:1174-1180`), so after Address starts there is no live panel to retry in.

**Investigation.** Since #1354 a restart from a reviewer or Consolidation rewinds and reruns the whole pass, keeping the old reviewers readable as a previous attempt. A per-reviewer rerun would have to keep the other reviewers' sessions live, supersede Consolidation and everything after it, and re-consolidate. The rewind machinery (`restartLocatedStage`, `build-pipeline-service-lifecycle.ts:1176`) supersedes by round and position, not by panel slot, so this is new rewind logic, not a flag.

**Decisions.**

- **Build it or close it?**
  - **Close it: keep the refusal and the whole-pass restart (recommended).**
    - Pros: no new rewind shape; the restart already keeps the old panel readable; nobody is blocked.
    - Cons: rerunning one bad reviewer costs the whole panel's time and tokens.
  - **Build a per-slot rerun that supersedes Consolidation onwards and re-consolidates.**
    - Pros: cheaper reruns on large panels.
    - Cons: a second supersede rule beside the round rule; Address and later steps must be invalidated like any rewind; needs its own tests and fixture.

## Current state

The build pipeline tab draws the pipeline on the shared flow graph (Ticket,
Setup, every pass unrolled to the right, the reviewer fan-out, Ship, PR) with
an inspector below. Unit tests cover the projection
(`apps/web/src/components/build-pipeline/pipeline-flow.test.ts`), the backend
reviewer retry (`apps/backend/src/core/build-pipeline-review-fanout-retry.test.ts`)
and the protocol fields; `e2e/PipelineFlow.spec.ts` covers the graph at phone
and desktop widths against a fixture backend.

Since then: node faces with runtime and live token usage (#1353), restarts that
rewind to a step's round with a "Previous attempt" node (#1354), the Ticket's
start row (#1356), validation lifecycle and skip controls (#1364), and code
rewind and package-only restart (#1376). The rewind work has its own file,
[0405-build-pipeline-rewind-follow-ups.md](0405-build-pipeline-rewind-follow-ups.md).

## Outstanding work

### Qualification

1. **A real pipeline end to end.** Run a fan-out pipeline on a `dev:test`
   profile through review, a failed verification, the fix pass and Ship, and
   check the line grows to the right as each pass starts, the faded steps ahead
   match what runs, the PR node picks up the PR and its checks, and leaving
   the tab and coming back restores the selection rules and transcript.
2. **Retry one reviewer on a real provider.** Fail one reviewer (a bad model id
   on one panel slot), retry it from its node, and check the panel consolidates
   with the retried report and the failed attempt stays readable. A retry
   keeps the slot's model, so a bad model id fails again; see task 2.
3. **Remote node.** Open a pipeline that runs on a remote leaf node: node
   state, transcripts, the PR node (the PR monitor mirror for a remote
   environment), double-click to open a session, and the review-pass tab.
4. **Session tabs from the graph.** A double click opens the stage's provider
   session with `requireExistingResumeSession`. Confirm, per provider, that
   opening a running stage's session attaches read-mostly and that a message
   typed there is not mistaken for the pipeline's own turn.
5. **Live token usage per provider.** Every stage session now records
   `tokenCount` while it runs (2026-10-27). Run a Build, a single review,
   consolidation, Verify and Ship on each harness (Claude, Codex, OpenCode,
   Cursor, Pi) and check the running node's third row shows a count within one
   transcript persist interval (5 s) of the provider's first usage report, and
   the final count after the turn. Cursor and Pi may only report at turn end;
   if so they show "—" while running, which is the intended neutral
   placeholder.

### Code

6. **Validation history.** The record keeps only the latest validation run, so
   only the newest Prepare node carries its checks. Keeping a bounded summary
   per run would let older passes show theirs. Runs invalidated by a rewind
   are already kept on their rewind (`PipelineRewind.validationRun`); this is
   about forward passes.
7. **Retry a reviewer after consolidation.** `retry_build_pipeline_reviewer`
   refuses once the pass is consolidated; the stage restart reruns the whole
   panel. A per-reviewer rerun that re-consolidates would need the address
   stage to be invalidated too.

## Constraints and rationale

Known limits, by design:

- The PR node shows the environment's PR only after the pipeline reached Ship
  (`pipeline-flow.ts:1169-1172`), so a PR opened by hand earlier is not shown
  as the pipeline's.
- The live-ticket note compares only a ticket the Kanban board has loaded; it
  never fetches one.

## Related

- [build-pipeline-view.md](../../architecture/build-pipeline-view.md): the design
- [0405-build-pipeline-rewind-follow-ups.md](0405-build-pipeline-rewind-follow-ups.md): restarts, previous attempts and code rewind
- [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md): the shared flow graph on Multi Review
