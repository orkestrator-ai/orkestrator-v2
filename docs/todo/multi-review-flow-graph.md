# Multi Review flow graph

Checked against `main` at `a31e2c0a` (2026-10-15).

The Multi Review tab shows the workflow as a left-to-right flow graph: review
package, then the reviewer panel, then consolidation, then Fix. An inspector
sits below the graph. It shows the selected node's status and actions, a live
transcript tail for reviewers, and the findings that completed reviewers have
reported so far. The redesign only changed the layout: it reads data the backend
already returns. The items below need data or state that the backend does not
keep yet.

## Current state

- **Graph.** `MultiReviewFlowGraph.tsx` draws the nodes as tabs that control
  the inspector. `multiReviewFlowLayout` (`multi-review-flow.ts`) computes their
  positions, and edges are hand-drawn SVG béziers. Edge state comes from
  `multiReviewFlowEdges`. A finished source takes its style from its target:
  `active`, `complete`, `ready` (output waiting for the next step), `failed`,
  or `pending` when nothing has flowed. Below 960 px the graph stacks into one
  column with straight connectors.
- **Inspector.** `MultiReviewInspector.tsx`. For a reviewer, the transcript tail
  reads `getMultiReviewReviewerTranscript`, echoing `knownSourceToken`. It reads
  once on each selection and on each workflow checkpoint. It polls through the
  read coordinator only while the reviewer is live and the tab is active.
  Preparation, consolidation and Fix show only status, model and runtime, plus
  Open session.
- **Findings so far.** `mergeReviewerFindings` lists the issues of completed
  reviewers. An issue that several reviewers raised at the same file, line and
  title is listed once. Partial reports from failed or stopped reviewers are not
  included.
- **Not built.** The design's zoom controls (−, 100%, +, fit).

## Outstanding work

### Code

1. **Findings from a reviewer that is still running.** A reviewer's report
   arrives whole, when its result is accepted (`reviewer.report`), so the
   findings column fills in one reviewer at a time. Live findings would need a
   per-reviewer channel for partial findings. The backend would have to validate
   it against the structured-review budgets, bound it, and drop it once the real
   report lands. The renderer must never parse findings out of the provider
   transcript; `toMultiReviewReviewerMessages` deliberately hides
   schema-shaped text.
2. **Queue position and expected start for queued reviewers.** A queued
   reviewer now shows `queued`, but neither its place in the admission queue
   nor when it will start. This builds on the deferred `admissionState` /
   `queuedAt` fields in
   [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md#deferred-until-measured).
   It also needs the scheduler (`runBoundedTasks`, admission concurrency 4 by
   default) to report a position. An estimate needs a measured per-provider
   duration; without one, show only the position.
3. **Transcript tail for preparation, consolidation and Fix.** These steps run
   in backend-owned native sessions. Unlike the reviewer transcript, they have
   no bounded read that echoes a token, so the inspector offers only Open
   session. A step-session read with the same contract (bounded tail,
   `knownSourceToken`, `unchanged` answers) would let the inspector show what
   the step is doing without opening a tab.
4. **Zoom controls, with zoom and pan kept between visits.** The layout already
   fits 1 to 8 reviewers. Zoom matters only for the 32-reviewer maximum and for
   narrow panes. Keep zoom and pan per workflow in renderer UI state, not in
   the workflow record. Reset them when the panel size changes.

## Constraints and rationale

- The graph is a projection of the workflow snapshot. Selection and scroll are
  view state. Nothing about a node's state may come from the transcript tail.
- Every new read needs explicit byte and count bounds, and must poll only for a
  visible, live node (AGENTS.md transport invariants 3 and 11).

## Related

- [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md): admission,
  reviewer transcripts and the deferred queue fields.
- [multi-review-panel-value.md](multi-review-panel-value.md): consolidation and
  reviewer overlap, which the findings column makes visible.
