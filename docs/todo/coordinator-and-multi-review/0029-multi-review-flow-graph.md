# Multi Review flow graph

Checked against `main` at `9906db30` (2026-10-16), plus the follow-ups that
built zoom and pan, failed-node errors, step transcript tails, queue position
and live findings.

The Multi Review tab shows the workflow as a left-to-right flow graph: review
package, then the reviewer panel, then consolidation, then Fix. An inspector
sits below the graph. It shows the selected node's status and actions and a
live transcript tail, and beside it the findings reviewers have reported so
far. Every follow-up from the redesign is built. What is left is qualifying
live findings on real providers and a few gaps found on the way.

## Current state

- **Shared components.** The graph, viewport, stacked layout, view store and
  inspector frame are shared with the build pipeline tab and live in
  `apps/web/src/components/flow-graph/` (`FlowGraph.tsx`, `FlowViewport.tsx`,
  `flow-viewport.ts`, `flow-graph-model.ts`, `FlowInspector.tsx`) and
  `stores/flowGraphViewStore.ts`. Multi Review supplies its nodes, its
  five-column layout and its edges; see
  [build-pipeline-view.md](../../architecture/build-pipeline-view.md).
- **Graph.** `MultiReviewFlowGraph.tsx` draws the nodes, through the shared
  `FlowGraph`, as tabs that control the inspector. `multiReviewFlowLayout`
  (`multi-review-flow.ts`) computes their positions, and edges are hand-drawn
  SVG béziers. Edge state comes from `multiReviewFlowEdges`. A finished source takes its style from its target:
  `active`, `complete`, `ready` (output waiting for the next step), `failed`,
  or `pending` when nothing has flowed. Below 960 px the graph stacks into one
  column with straight connectors.
- **Zoom and pan.** The graph sits in a scrolling viewport up to 720 px tall
  (`FlowViewport.tsx`, maths in `flow-viewport.ts`). −, the zoom level (which
  resets to 100%), + and Fullscreen sit in its bottom-right corner; zoom runs
  from 20% to 200%. There is no Fit control: it was removed in #1199, and the
  browser suite asserts it stays gone. Fullscreen portals the graph
  over the whole Multi Review tab (an `@container` ancestor would confine a
  fixed overlay) and the viewport takes the tab's height; the button or an
  Escape no menu or dialog handled leaves it. Dragging the canvas, wheel and
  trackpad scrolling pan it, but a press that React bubbles up from a node's
  portaled context menu never starts a drag, since capturing its pointer would
  swallow the menu item's selection; Ctrl/⌘ + wheel, a trackpad pinch and a two-finger touch
  pinch zoom around the pointer, while a plain wheel is left to scrolling so
  the page still scrolls past the graph. A node reached from the keyboard is
  scrolled into view first. Zoom and pan are kept per workflow in
  `flowGraphViewStore` (renderer only, at most 50 workflows) and reset
  when the panel width changes.
- **Zoom in the stacked layout.** Below 960 px the column has the same
  controls, range and presets, in a sticky row at its top with 44 px touch
  targets. The column scales inside a viewport that scrolls only sideways and
  grows with it, so vertical scrolling stays with the page and the inspector
  below stays reachable. It keeps its own view, under the workflow
  id plus `stacked`, so each layout restores what it was left at.
- **Failed nodes.** A failed reviewer or step shows the first line of its
  error in place of its model, truncated to the node. The whole text is the
  node's accessible description and its tooltip, which also opens on keyboard
  focus. Steps take the workflow error, or the Fix session's own once the fix
  is interactive.
- **Inspector.** `MultiReviewInspector.tsx`. Every node has a transcript tail.
  Each step is a keyword and its subject; narrative (`say`) lines drop the
  keyword and read in white against the grey steps.
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
  reviewers' accepted reports, plus what reviewers reported through the
  `report_finding` MCP tool before a report was accepted
  (`reviewer.provisionalFindings`; see "Provisional findings" in
  [agent-engines.md](../../architecture/agent-engines.md#provisional-findings-report_finding)).
  An issue that several reviewers raised at the same file, line and title is
  listed once, and a row an accepted report confirms is confirmed. Other rows
  are marked "provisional" while their reviewer runs, or "unconfirmed (reviewer
  failed)" / "(reviewer stopped)" once it ended without a report. The reviewer's
  inspector says how many it reported. The accepted report replaces them,
  consolidation never reads them, and they are removed once the workflow is
  `interactive` or `completed`. Partial reports from failed or stopped
  reviewers are still not included, and findings are never read out of a
  transcript.
- **Read-only Grok and Pi reviewers.** Their bridges gate tools themselves,
  and a packaged review's reviewer turns are read-only, so neither let a
  reviewer call its own result tools. The prompt now names the turn's attempt
  (`workflowResultTool`, `workflowResultKey`) and both bridges let that
  attempt's own tools through for calls naming its key: submit, validate,
  status and `report_finding` ("Attempt tools in read-only turns" in
  [agent-engines.md](../../architecture/agent-engines.md#attempt-tools-in-read-only-turns-grok-pi)).
  Consolidation and Fix turns on Grok or Pi do not declare their attempt yet.

## Outstanding work

### Code

1. **Pi: confirm the bridge-owned MCP extension loads in a read-only session.**
   Read-only Pi sessions set `noExtensions` for project resources
   (`projectResourceDiscoveryOptions`). The bridge registers its Orkestrator
   tools through an inline `extensionFactories` entry, which should not be
   affected, but no test covers it.

### Qualification

- **Read-only Grok and Pi reviewers submit their report.** In a packaged review,
  check that a Grok and a Pi reviewer each validate and submit
  `submit_review_report` and the workflow consolidates their report. Grok's
  permission request must carry the call's arguments (`rawInput`, or
  `tool_input` under `use_tool`) for the key check to pass; confirm it does.
- **`report_finding` on every provider.** Run a packaged Multi Review with one
  reviewer per provider (Claude, Codex, Cursor, Grok, OpenCode, Pi) and check
  that each reviewer calls the tool, that "Findings so far" fills in while it
  runs, that the accepted report replaces the provisional rows, and that a
  reviewer stopped mid-run keeps its findings as unconfirmed. Repeat one
  provider in a container environment, where the attempt server is reached at
  `host.docker.internal`. Each bridge's auto-allow path has a unit test; none
  has been run against a real model. Batch with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
- **Zoom, pan and the error tooltip on real devices.** The browser suite
  covers them in Chromium at desktop and phone sizes (`e2e/MultiReviewFlow.spec.ts`),
  including Ctrl + wheel and a synthetic two-finger touch pinch, but not a real
  trackpad pinch in the desktop app, a phone's own pinch, or Safari's gesture
  events in the web client.

### Known limits (by design)

- A finding staged by `report_finding` lives in memory until the next review
  pass records it; one staged when the backend stops is lost. The report still
  carries it.
- A queue position is an observation, so the stored one can trail the
  scheduler by one admission until the next commit.
- No expected start time for queued reviewers: nothing measures how long a
  provider takes to admit one.
- The new reviewer fields (`admissionState`, `queuePosition`,
  `provisionalFindings`) are additive, but the strict workflow validators of an
  older backend or renderer reject a workflow that carries them. They exist
  only while a review is running (admission fields while a reviewer is queued,
  provisional findings until the report lands or the workflow completes), so a
  downgrade or an old gateway tab is affected only for a workflow mid-review.

## Constraints and rationale

- The graph is a projection of the workflow snapshot. Selection, zoom and pan
  are view state and never reach the workflow record. Nothing about a node's
  state may come from the transcript tail.
- Every new read needs explicit byte and count bounds, and must poll only for a
  visible, live node (AGENTS.md transport invariants 3 and 11).
- Provisional findings are progress, never results: the renderer only shows
  them, consolidation never reads them, and the accepted report wins. A tool a
  read-only turn may call must touch nothing in the workspace; `report_finding`
  writes only to its own attempt's record in the backend.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md): admission,
  reviewer transcripts and the queue fields.
- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md): consolidation and
  reviewer overlap, which the findings column makes visible.
