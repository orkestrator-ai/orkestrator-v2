# Build pipeline view

Status: Living. Checked against the branch that introduced the pipeline flow
graph (2026-10-26) and the branch that made restarts rewind (2026-10-27).

The build pipeline tab shows the pipeline as a left-to-right flow graph across
the top and an inspector for the selected step below it, like the Multi Review
tab. The old PIPELINE stage list (`PipelineStageRail`) is gone.

## Shared flow graph

Multi Review and the pipeline draw with the same components in
`apps/web/src/components/flow-graph/`:

| File | What it owns |
| --- | --- |
| `flow-graph-model.ts` | Node and edge state vocabulary (`FlowNodeState`, `FlowEdgeState`, `flowEdgeState`), `summarizeFlowEdges`, `defaultFlowSelection`, `latestActivityAt`, edge paths (`flowEdgePath`, `bypassEdgePath`), `FlowGraphGeometry`. |
| `FlowGraph.tsx` | Node faces (state colours, icon, title, runtime, detail or first error line, severity chips, validation chips, an extra row), error tooltips, hand-drawn SVG edges and ports, column labels, the stacked column below 960 px with its sticky zoom controls, keyboard navigation, fullscreen, the height divider. |
| `FlowViewport.tsx`, `flow-viewport.ts` | Zoom and pan maths and the viewport hook (Ctrl/⌘ + wheel, trackpad and touch pinch, drag to pan, opt-in Fit), the zoom controls and divider. |
| `FlowInspector.tsx` | The inspector frame: the tab panel the nodes control, and its header (icon, title, status pill, tokens, actions). |
| `stores/flowGraphViewStore.ts` | Renderer-only view state per workflow: zoom and pan (at most 50) and whether the graph is collapsed (at most 50). Never sent to the backend. |

A workflow supplies the nodes in keyboard order, a layout function from width
to geometry, the edges, ports and the stacked stages. Multi Review keeps its
own five-column layout (`multiReviewFlowLayout`) and looks and behaves as
before. The shared zoom controls offer Fit ("Fit the whole pipeline") when a
graph passes `fitControl`: it zooms out, never past 100% in and never below
20%, until the whole wide graph shows in its viewport, or the stacked column in
the panel that scrolls it, and scrolls back to the start. The pipeline turns it
on, since its unrolled passes grow the line without bound. Multi Review leaves
it off: it removed Fit in #1199 and its browser suite asserts it stays gone.

## The pipeline graph

`pipelineFlowModel` (`components/build-pipeline/pipeline-flow.ts`) projects the
pipeline record onto nodes and columns. Nothing about a node's state comes from
a transcript.

- **Line.** Ticket, Setup, then every session in the order it ran, then the PR.
  Package preparation and the validation run make a Prepare node; fan-out
  reviewers of one pass share a column, followed by Consolidation; Address,
  Verify, Fix, Ship and conflict resolution are one node each. A repeated pass
  is a new node to the right ("Review 2", "Verify 2", "Fix 2"), never a loop
  back, so the whole history is on the line. Sessions a restart superseded
  are one greyed "Previous attempt" node instead (see
  [Restarting a step](#restarting-a-step)); live numbering skips them.
- **Ahead.** Steps the pipeline will definitely reach are drawn faded
  (`placeholder`): Build, Prepare (fan-out or a configured preparation model),
  the reviewers or Review, Consolidation (fan-out), Verify, Ship and the PR.
  Address, Fix, conflict resolution and extra passes are never drawn ahead and
  never dimmed; they appear when they start. A finished or cancelled pipeline
  has nothing ahead.
- **Fan-out.** The live pass reads `reviewFanout.reviewers`: status, queue
  position ("queued · #3 of 7"), "starting", the error, issue counts. Reviewers
  with no session yet are nodes too. Once the pass is retired, each reviewer
  session keeps how it ended (`reviewerOutcome`), a bounded `error` (2,000
  characters) and per-severity `reviewIssueCounts`; older records without them
  fall back to the session status. Reviewers that failed before session creation
  are retained in the consolidation session’s `sessionlessReviewers` summary
  (at most one entry per panel slot, bounded model and error text), so their
  model and diagnostic remain inspectable after the live pass is retired.
  Blank provider diagnostics use a nonblank fallback so failure snapshots
  remain valid. A retried reviewer replaces its failed
  attempt in the same slot, and the inspector says how many earlier attempts
  there were.
- **Stops.** The current session carries a pause, failure or cancellation. A
  stage that failed or paused before its session existed gets a node of its
  own; a fan-out that failed without consolidating carries it on
  Consolidation.
- **Ticket.** Always first and complete, no elapsed time. The inspector shows
  the stored `taskSnapshot` (title, description, acceptance criteria, reference
  images, comments; Markdown rendered; empty sections omitted), never the
  bridge prompt. A pipeline without a snapshot shows a placeholder. When the
  board has already loaded the Kanban ticket and it now reads differently, a
  note says so; nothing is fetched for it.
- **PR.** The environment's pull request (`prUrl`, `prState`) and the PR
  monitor's `checkSummary`, shown only once the pipeline has a Ship session (an
  older PR on a reused environment is not this pipeline's). The monitor owns
  polling and its bounds; the graph adds no read.

Node colours and edge states follow Multi Review. Faces show the agent and
model (or the error's first non-blank line, with the whole error in the
tooltip and, through a visually hidden element, the accessible description;
Multi Review instead joins every line, `errorFace="joined"`), elapsed time and tokens, and issue counts on review
nodes. Columns have a fixed width (`pipelineFlowLayout`); a long pipeline
scrolls sideways and a short one is centred. The graph's own height starts at
240 px and its divider height is remembered separately from Multi Review's.

## Inspector and actions

`PipelineFlowView` owns selection, which follows the running step (or the last
step reached) until the user clicks a node. A click selects; a double click
opens the step's provider session in a tab of its own (`requireExistingResumeSession`,
so a missing session never opens as an empty one). The inspector shows the
status, the actions, and for a session the full transcript with the same
renderer, virtualization, find and report footer the tab always had
(`PipelineSessionTranscript`). The message box shows only on the session the
pipeline is running, under the rules the tab already had. Only the active,
focused pane publishes its selected session to the shell and owns transcript
find shortcuts; activation republishes that pane’s independent selection. A Prepare node with a
validation run has a Tests view; the transcript stays mounted behind it.

Actions sit in each node's context menu and in the inspector: open the session
(Open Fix session on a Fix node), open the review pass as a Multi Review tab,
retry a failed reviewer (`retry_build_pipeline_reviewer`), retry the failed
step (`retry_build_pipeline_stage`), restart from a step
(`restart_build_pipeline_step`), view the PR, and pause, resume or cancel the
pipeline. The header keeps its controls.

The review pass tab is a `multi-review` tab whose data names the pipeline and a
`pipelinePass`; it renders the same view narrowed to that pass. Layout restore
keeps it while the pipeline exists.

## Restarting a step

"Restart from here" (`restart_build_pipeline_step`) on any live step — Build,
Fix, Prepare or its validation, a reviewer or consolidation (the whole review
pass reruns), Review, Address, Verify, Ship or conflict resolution — rewinds
the pipeline to that step's own round and position and runs it again. The
backend (`restartLocatedStage` in `build-pipeline-service-lifecycle.ts`, rules
in `build-pipeline-rewind.ts`):

- **Rewinds the round.** `iteration` becomes the step's own, so the rounds
  after it are available again: restarting round 1's Verify after round 4
  failed runs Verify 1, then on failure Fix 2, Verify 2 and so on up to
  `maxIterations`.
- **Keeps the code.** The worktree and branch are not reset; the rerun and
  every later step work on the current code, later rounds' commits included.
  Rewinding the code itself would be a separate, confirmed action
  ([0405](../todo/coordinator-and-multi-review/0405-build-pipeline-rewind-follow-ups.md)).
- **Invalidates what came after.** Every live session at or after the point
  (same round and later step, or a later round) gets `supersededBy` (the
  `PipelineRewind.id`) and `supersededAt`. A rewind into an earlier round also
  drops the review package, validation run, structured review and verdict,
  because they describe later code; a step whose inputs are gone reruns from
  the earliest step of its round that rebuilds them (Review prepares the
  package again; Address without that round's report reruns Review). Verify
  sessions keep their own verdict (`verificationResult`,
  `verificationFeedback`, bounded), so a restarted Fix gets the verdict that
  ended the round before it.
- **Treats superseded sessions as history.** They are never the current
  session (`sessionForCurrentPhase`), never the source of a fix baseline (a
  same-round restart still carries the first attempt's baseline), an address
  handoff, a review report owner or a Multi Review evaluation; all their
  result slots are closed `superseded`, so a late tool submission is denied.
- **Records the rewind.** `rewinds` (at most 50) says when, from which phase
  and round, to which round and step, which session was named and how many
  sessions were superseded. A repeat of the same request (a double click, a
  retried command) is a no-op; restarting a superseded step is refused.
- **Works from `failed` and `complete`.** The phase is set and the request
  persisted in one locked write, so the supervisor and recovery pick it up as
  for any active pipeline. Consuming the request moves a Kanban ticket back to
  In progress; the next terminal outcome reconciles it again and its comments
  dedupe. A Ship after an earlier Ship is told the existing PR URL and updates
  (or reopens) that PR instead of creating one. A pipeline whose PR has merged
  refuses restarts.

`restart_build_pipeline_current_step`, `retry_build_pipeline_stage` and
`retry_build_pipeline_review` keep their semantics; restarting the current step
supersedes only that step's session. Restarting a Build or Fix that also wrote
the package plan reruns the Build or Fix; the dedicated preparation session
restarts preparation alone.

**Presentation.** Each rewind's superseded sessions are one greyed, dashed
"Previous attempt" node (kind `attempt`, column marked `superseded`) where the
restart rewound to, followed by the rerun to the right. The live line routes
over it (`route: "bypass"`; the stacked column draws the bypass beside it),
and the attempt branches off the step before it. Its inspector says when and
from where the restart rewound and lists the steps; "Show steps" expands it
into greyed nodes titled by round ("Fix · round 2", reviewers of one pass in
one column), each selectable with its transcript readable and a "Superseded by
a restart" note, and no restart or retry. Expansion is renderer-only view
state (`flowGraphViewStore.expandedAttempts`, at most 50). Superseded nodes are
left out of the step count, review-pass numbering, stop placement and the
followed selection. The record fields are generic (any renderer can group
sessions by `supersededBy` and read `rewinds`).

`retry_build_pipeline_reviewer` reruns one failed reviewer of the current pass,
keeps the rest of the panel, discards a started consolidation, and resumes a
review that failed or paused. The failed attempt's session stays as history
under its key; the retry gets `…:attempt-2`.

## Constraints

- The graph reads the pipeline record (plus the environment's PR monitor state
  for the PR node). Selection, zoom, pan and collapse never reach the record.
- Transcripts are read as before: the shown stage's body through
  `get_build_pipeline` with `prioritySessionKey`, once per revision and only
  while the tab is active and the stage is shown, within the existing patch
  budget. The graph adds no polling; the live clock ticks only while a node
  runs and the tab is active.
- New record fields are additive and optional; the pipeline guard accepts
  records without them. Records written before rewinds existed load as before
  and are superseded by their first restart like any other.

Follow-ups: [0315-build-pipeline-flow-graph.md](../todo/coordinator-and-multi-review/0315-build-pipeline-flow-graph.md),
[0405-build-pipeline-rewind-follow-ups.md](../todo/coordinator-and-multi-review/0405-build-pipeline-rewind-follow-ups.md).
