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
- **Zoom and pan.** The graph sits in a scrolling viewport up to 720 px tall
  (`MultiReviewFlowViewport.tsx`, maths in `multi-review-flow-viewport.ts`).
  −, the zoom level (which resets to 100%), + and Fit sit in its bottom-right
  corner; zoom runs from 20% to 200%. Dragging the canvas, wheel and trackpad
  scrolling pan it; Ctrl/⌘ + wheel and pinch zoom around the pointer, while a
  plain wheel is left to scrolling so the page still scrolls past the graph.
  A node reached from the keyboard is scrolled into view first. Zoom and pan
  are kept per workflow in `multiReviewFlowViewStore` (renderer only, at most
  50 workflows) and reset when the panel width changes. The stacked layout has
  no zoom.
- **Failed nodes.** A failed reviewer or step shows the first line of its
  error in place of its model, truncated to the node. The whole text is the
  node's accessible description and its tooltip, which also opens on keyboard
  focus. Steps take the workflow error, or the Fix session's own once the fix
  is interactive.
- **Inspector.** `MultiReviewInspector.tsx`. Every node has a transcript tail.
  A reviewer's reads `getMultiReviewReviewerTranscript`; preparation,
  consolidation and Fix read `getMultiReviewStepTranscript`
  (`get_multi_review_step_transcript`, `multi-review-step-transcript.ts`),
  which has the same contract with tighter bounds: at most 100 messages and
  256 KiB, a session-scoped `knownSourceToken`, and `unchanged` answers with no
  messages. Each tail reads once on selection and on each workflow checkpoint,
  and polls through the read coordinator only while its node is live, the
  window visible and the tab active. A session that several steps share (older
  workflows ran all three in the fix session) is read only for the step using
  it now (`multiReviewStepSessionAccess`, which follows the same rule as
  `fixSessionRuntimeStep`); the other steps say which step has it. Step tails
  hide prompts and schema-shaped text exactly as reviewer tails do.
- **Queue position.** A pending reviewer in a review pass shows its place in
  the admission queue ("queued · #3 of 7"), or "starting" while its session
  is set up. `runBoundedTasks` (`review-fanout-scheduler.ts`) reports its
  waiting queue as each task leaves it, and `ReviewFanoutRunner` projects that
  onto the reviewer records (`admissionState`, `queuePosition`;
  `review-fanout-admission.ts`). The fields are observations: they ride on the
  pass's own safety commits and its one observational flush, so a position can
  trail by one admission until the next commit. Stopping a queued reviewer
  moves the ones behind it up; a restarted reviewer rejoins at its panel
  place on the next pass. A backend without the fields shows a bare "queued".
  There is deliberately no expected start time: nothing measures how long a
  provider takes to admit a reviewer.
- **Findings so far.** `mergeReviewerFindings` lists the issues of completed
  reviewers. An issue that several reviewers raised at the same file, line and
  title is listed once. Partial reports from failed or stopped reviewers are not
  included.

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

## Constraints and rationale

- The graph is a projection of the workflow snapshot. Selection, zoom and pan
  are view state and never reach the workflow record. Nothing about a node's
  state may come from the transcript tail.
- Every new read needs explicit byte and count bounds, and must poll only for a
  visible, live node (AGENTS.md transport invariants 3 and 11).

## Related

- [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md): admission,
  reviewer transcripts and the deferred queue fields.
- [multi-review-panel-value.md](multi-review-panel-value.md): consolidation and
  reviewer overlap, which the findings column makes visible.
