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
  reviewers' accepted reports, plus what reviewers reported through the
  `report_finding` MCP tool before a report was accepted
  (`reviewer.provisionalFindings`; see "Provisional findings" in
  [agent-engines.md](../architecture/agent-engines.md#provisional-findings-report_finding)).
  An issue that several reviewers raised at the same file, line and title is
  listed once, and a row an accepted report confirms is confirmed. Other rows
  are marked "provisional" while their reviewer runs, or "unconfirmed (reviewer
  failed)" / "(reviewer stopped)" once it ended without a report. The reviewer's
  inspector says how many it reported. The accepted report replaces them,
  consolidation never reads them, and they are removed once the workflow is
  `interactive` or `completed`. Partial reports from failed or stopped
  reviewers are still not included, and findings are never read out of a
  transcript.

## Outstanding work

### Code

1. **Read-only Grok and Pi reviewers may not be able to submit their report.**
   Found while making `report_finding` callable; not changed, because it is
   outside that work and needs a live check first. In a packaged review every
   reviewer turn is read-only. The ACP bridge then denies every permission
   request (`approvals: "deny"` short-circuits `orkestratorToolPermissionOption`,
   and `onPermission` cancels the rest), and Grok asks before every MCP call;
   the Pi bridge's read-only gate in `requestToolApproval` blocks every tool but
   `read`, `grep`, `find`, `ls` and coordinator mail. Neither exempts the
   attempt's own `validate_workflow_result`, `submit_review_report` or
   `get_workflow_result_status`, so on the code alone those reviewers would
   end on the missing-result reminder. `report_finding` is exempted in both. If
   a live run confirms it, exempt the attempt's result tools the same way.
2. **Pi: confirm the bridge-owned MCP extension loads in a read-only session.**
   Read-only Pi sessions set `noExtensions` for project resources
   (`projectResourceDiscoveryOptions`). The bridge registers its Orkestrator
   tools through an inline `extensionFactories` entry, which should not be
   affected, but no test covers it.

### Qualification

- **`report_finding` on every provider.** Run a packaged Multi Review with one
  reviewer per provider (Claude, Codex, Cursor, Grok, OpenCode, Pi) and check
  that each reviewer calls the tool, that "Findings so far" fills in while it
  runs, that the accepted report replaces the provisional rows, and that a
  reviewer stopped mid-run keeps its findings as unconfirmed. Repeat one
  provider in a container environment, where the attempt server is reached at
  `host.docker.internal`. Each bridge's auto-allow path has a unit test; none
  has been run against a real model. Batch with
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).
- **Zoom, pan and the error tooltip in the desktop app.** The browser suite
  covers them in Chromium (`e2e/MultiReviewFlow.spec.ts`), including Ctrl +
  wheel, but not a real trackpad pinch, or Safari's gesture events in the web
  client.

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

- [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md): admission,
  reviewer transcripts and the queue fields.
- [multi-review-panel-value.md](multi-review-panel-value.md): consolidation and
  reviewer overlap, which the findings column makes visible.
