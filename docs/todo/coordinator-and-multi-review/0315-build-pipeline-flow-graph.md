# Build pipeline flow graph follow-ups

Checked against the branch that introduced the pipeline flow graph
(2026-10-26). The design is in
[build-pipeline-view.md](../../architecture/build-pipeline-view.md).

## Current state

The build pipeline tab draws the pipeline on the shared flow graph (Ticket,
Setup, every pass unrolled to the right, the reviewer fan-out, Ship, PR) with
an inspector below. Unit tests cover the projection (`pipeline-flow.test.ts`),
the backend reviewer retry (`build-pipeline-review-fanout-retry.test.ts`) and
the protocol fields; `e2e/PipelineFlow.spec.ts` covers the graph at phone and
desktop widths against a fixture backend.

## Outstanding work

### Qualification

1. **A real pipeline end to end.** Run a fan-out pipeline on a `dev:test`
   profile through review, a failed verification, the fix pass and Ship, and
   check the line grows to the right as each pass starts, the faded steps ahead
   match what runs, the PR node picks up the PR and its checks, and leaving
   the tab and coming back restores the selection rules and transcript.
2. **Retry one reviewer on a real provider.** Fail one reviewer (a bad model id
   on one panel slot), retry it from its node, and check the panel consolidates
   with the retried report and the failed attempt stays readable.
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
   transcript persist interval of the provider's first usage report, and the
   final count after the turn. Cursor and Pi may only report at turn end; if
   so they show "—" while running, which is the intended neutral placeholder.

### Code

6. **Validation history.** The record keeps only the latest validation run, so
   only the newest Prepare node carries its checks. Keeping a bounded summary
   per run would let older passes show theirs.
7. **Retry a reviewer after consolidation.** `retry_build_pipeline_reviewer`
   refuses once the pass is consolidated; the stage restart reruns the whole
   panel. A per-reviewer rerun that re-consolidates would need the address
   stage to be invalidated too.

## Known limits (by design)

- The PR node shows the environment's PR only after the pipeline reached Ship,
  so a PR opened by hand earlier is not shown as the pipeline's.
- The live-ticket note compares only a ticket the Kanban board has loaded; it
  never fetches one.
