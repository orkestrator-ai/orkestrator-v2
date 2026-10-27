# Build pipeline view

Status: Living. Checked against the branch that introduced the pipeline flow
graph (2026-10-26), and the node-face and live-usage follow-up (2026-10-27).

The build pipeline tab shows the pipeline as a left-to-right flow graph across
the top and an inspector for the selected step below it, like the Multi Review
tab. The old PIPELINE stage list (`PipelineStageRail`) is gone.

## Shared flow graph

Multi Review and the pipeline draw with the same components in
`apps/web/src/components/flow-graph/`:

| File | What it owns |
| --- | --- |
| `flow-graph-model.ts` | Node and edge state vocabulary (`FlowNodeState`, `FlowEdgeState`, `flowEdgeState`), `summarizeFlowEdges`, `defaultFlowSelection`, `latestActivityAt`, edge paths (`flowEdgePath`, `bypassEdgePath`), node heights (`flowNodeHasRuntimeRow`, `flowNodeHeight`), `FlowGraphGeometry`. |
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
  back, so the whole history is on the line.
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

Node colours and edge states follow Multi Review. Columns have a fixed width
(`pipelineFlowLayout`); a long pipeline scrolls sideways and a short one is
centred. The graph's own height starts at 240 px and its divider height is
remembered separately from Multi Review's.

### Node faces

Every node face, in both graphs, is built from rows (`data-flow-node-row`):

1. **Title** — the title, whole, and at most a small badge that gives way to
   it ("ahead", "queued · #1 of 3", "not started"). The title never shares its
   row with the clock or the token count, so it is never cut short by them.
2. **Detail** — `{agent} · {model} · {effort}`, or the subtitle that stands for
   it ("Local worktree", "No pull request yet"), or a failed node's error
   (its first non-blank line, with the whole error in the tooltip and,
   through a visually hidden element, the accessible description; Multi Review
   instead joins every line, `errorFace="joined"`). This is the only text that
   truncates: it ends in an ellipsis and keeps its whole text in a tooltip.
   Severity chips, and the state word of a node that is not running
   ("paused", "failed", "stopped"), sit at its end.
3. **Runtime** — `{elapsed} · {tokens}`, with the running state word
   ("running", "reviewing", "stalled"). Shown whenever the node runs, and kept
   after it ran when a runtime was recorded.

So a node that has not run (or a placeholder ahead) has two rows, and a
running node three. **Decision:** a finished node keeps its final duration and
tokens on row 3 rather than moving them onto row 2. That keeps the runtime in
one place, a node's height unchanged when it finishes (so nothing on the graph
moves as a stage completes), and the detail row free for the model and the
severity chips. The cost is a finished node 18 px taller than a two-row one.
Validation chips and the PR's checks are further rows under the face.

`flowNodeHeight` turns those rows into the height the wide layouts give a
node (64 px for two rows, 82 px with the runtime row, plus 28 px of chips or
20 px of checks), and both `pipelineFlowLayout` and `multiReviewFlowLayout`
centre a taller node on the same line as its neighbours, so edges still meet
every node at its vertical centre. Node widths do not change. The stacked
column lays nodes out by their content, so it needs no heights, and Fit
measures what was laid out.

A running node whose provider has not reported usage yet shows a dash in place
of the count ("2m 35s · —"); its accessible name and the inspector leave the
count out rather than calling it pending.

### Token usage

The graph reads each node's tokens from `PipelineSession.tokenCount` on the
pipeline record, never from a transcript. The backend writes it for every stage
session: fan-out reviewers mirror their reviewer record, and every other stage
(Build, Fix, review-package preparation, a single review, Consolidation,
Address, Verify, Ship, conflict resolution) is metered by
`recordPipelineSessionUsage` from the same provider status read that drives
the stage. The provider's cumulative `contextUsage.sessionTokens` is used
when the status read carries it (the Claude and Codex bridges update it while
a turn runs; others report it when their bridge does); a provider that meters from its transcript
(OpenCode) is metered from the transcript read the pass already made. The count
only grows, is saved on the transcript persist cadence while the turn runs and
with the final transcript when it ends, and a meter that fails never fails the
stage. The validation run of a Prepare node, the Ticket, Setup and the PR run
no agent and have no tokens.

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
  records without them.

Follow-ups: [0315-build-pipeline-flow-graph.md](../todo/coordinator-and-multi-review/0315-build-pipeline-flow-graph.md).
