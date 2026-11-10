# Build pipeline view

> **Names.** Rework runs after Verify finds the ticket unmet, under the Build
> step's model. Address Findings runs after review reports findings, under the "Address
> review findings" setting; Multi Review's step of that name is the same job.
> Stored and transmitted values still say `fix` and `address` until
> [4740](../todo/cross-cutting/4740-workflow-vocabulary-stage-two.md), and "fix"
> means Rework in a pipeline but Address Findings in a Multi Review
> (`workflow-vocabulary.ts`).

Status: Living. Checked against the branch that introduced the pipeline flow
graph (2026-10-26), the branch that made restarts rewind (2026-10-27), the
node-face and live-usage follow-up (2026-10-27), and the rewind follow-ups
(code rewind, Address from the round's report, package-only restart;
2026-10-28), the shared review routing (2026-10-29), read-only reviewers
with the Git guard (2026-10-29), per-stage instructions (2026-10-29),
reviewer lenses (2026-10-29), the CLI's `build launch` (2026-10-29), the
header's key information panel (2026-11-01), delivery policies (2026-11-02),
per-worker mailboxes (2026-11-03), the Notes step (2026-11-04), and stopping
one reviewer (2026-11-05).

The build pipeline tab shows the pipeline as a left-to-right flow graph across
the top and an inspector for the selected step below it, like the Multi Review
tab. The old PIPELINE stage list (`PipelineStageRail`) is gone.

## Terms

- **Build pipeline**: the durable workflow (build, review, fix, verify, PR,
  conflict resolution) this tab shows.
- **Pipeline environment**: an environment a build pipeline created and runs
  in. A ticket's Build button, the Features view, `start_build_pipeline`, the
  CLI's `build launch` and the New Environment dialog's "A feature" option all
  make one. The sidebar marks it with the pipe icon (`PipeIcon.tsx`).
- **Prompt environment**: an environment that runs one prompt, from the New
  Environment dialog's "With a prompt" option or a coordinator's
  `launch_environment`. Review and the PR are started by hand or by a
  coordinator.

The New Environment dialog keeps the "A feature" / "With a prompt" wording and
says under it which of the two each choice creates. Internal names still say
"feature build" (`BuildIntent = "feature" | "prompt"`, `createFeatureBuild`,
the `create_feature_build` command, `featureBuildRequestHash`, the `feature-build.*` log
events): they are persisted or part of the backend contract, so they were not
renamed.

## Starting a build

Every launcher sends only what the user explicitly chose, and the backend fills
the rest in one place:

| Launcher | Command | What it sends |
| --- | --- | --- |
| Build buttons (Kanban, Linear, GitHub) | `launch_build_pipeline` (`build-pipeline-launch.ts`) | The ticket and any step, reviewer, agent or "When verified" choice the launcher set |
| Features view | `start_feature_plan_build` (`feature-plan-build.ts`) | The feature plan id |
| CLI `build launch`, coordinator | `build.launch`, `start_coordinator_build_pipeline` / `start_controller_build_pipeline` | Their request; a coordinator build must name a ticket in the project and is linked to it (`source: kanban`, [coordinator](coordinator.md#launch-defaults)) |

All of them apply `buildPipelineInputWithDefaults`
(`coordinator-launch-defaults.ts`), which is documented at the top of
`build-pipeline-launch.ts`: an explicit step replaces the saved one, a step with
no agent keeps the saved selection, and the review step is always the first
reviewer. A saved row pins only a model its action or saved reviewer names
itself; a model inherited from the platform's own setting is left out, so the
stage resolves it when it starts and gets the same unoffered-default swap a new
session gets (a Codex default a ChatGPT login does not offer runs on the live
list's first model, for that stage only). A launcher may still resolve the same
defaults to display them (`@orkestrator/protocol/build-pipeline-defaults`);
panels that resolve rows against the catalogue fill the inherited model back in
before catalogue resolution (`buildPipelineLauncherDefaults`). The New
Environment feature launcher submits these concrete choices even with
Customize models off, so it relies on the renderer catalogue fallback, not
the stage-time unoffered-default swap. The Build dialog also submits concrete
choices. The ticket snapshot, source
link and naming prompt come from the mappers in
`@orkestrator/protocol/build-pipeline-tickets`.

`start_feature_plan_build` formats the stories, creates the ticket, claims the
plan, starts the pipeline and records the link, compensating on failure: a claim
is released only while no pipeline is linked, and a new ticket deleted only
while no pipeline record holds it. A plan claimed by a launch that stopped
midway reuses that claim's ticket. A feature plan's build runs on Codex unless the caller
names another agent, because the story prompt asks for Codex threads and the
build reuses the plan's Codex planning environment.

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
before. The shared zoom controls offer Fit when a graph passes `fitControl`. There is
no separate button: the zoom level toggles, fitting the graph when it reads
100% and resetting to 100% otherwise. Fit zooms out, never past 100% in and
never below 20%, until the whole wide graph shows in its viewport, or the
stacked column in the panel that scrolls it, and scrolls back to the start. The pipeline turns it
on, since its unrolled passes grow the line without bound. Multi Review leaves
it off: it removed Fit in #1199 and its browser suite asserts it stays gone.

## The pipeline graph

`pipelineFlowModel` (`components/build-pipeline/pipeline-flow.ts`) projects the
pipeline record onto nodes and columns. Nothing about a node's state comes from
a transcript.

- **Line.** Ticket, Setup, then every session in the order it ran, then the PR.
  Package preparation and the validation run make a Prepare node; fan-out
  reviewers of one pass share a column, followed by Consolidation; Address Findings,
  Verify, Rework, Ship and conflict resolution are one node each. A repeated pass
  is a new node to the right ("Review 2", "Verify 2", "Rework 2"), never a loop
  back, so the whole history is on the line. Sessions a restart superseded
  are one greyed "Previous attempt" node instead (see
  [Restarting a step](#restarting-a-step)); live numbering skips them.
- **Earlier validation.** The record's `validationRun` is only the current
  pass's. When a failed Verify starts the next round, or a review retry
  prepares a new package, the old run's summary moves to `validationHistory`
  (newest 20: per command its status, exit code and duration, no output).
  Each summary sits on the Prepare node of the session that planned it (the
  newest session started before the run), or on a Prepare node of its own
  after a Build that wrote the plan; inside an expanded "Previous attempt"
  when that session was superseded. Its Tests view is read-only and has no
  command output.
- **Ahead.** Steps the pipeline will definitely reach are drawn faded
  (`placeholder`): Build, Prepare (fan-out or a configured preparation model),
  the reviewers or Review, Consolidation (fan-out), Verify, Ship and the PR.
  Address Findings, Rework, conflict resolution and extra passes are never drawn ahead and
  never dimmed; they appear when they start. A finished or cancelled pipeline
  has nothing ahead.
- **After review.** One rule routes both review paths (`stageAfterReview` in
  `build-pipeline-service-helpers.ts`): the accepted report, a single
  reviewer's or the panel's consolidated one, goes to Address Findings when it has
  issues or test coverage gaps, and straight to Verify when it has neither. So
  a clean pass is followed by Verify on the line, with no Address Findings node. The
  fan-out opens the next stage before it drops `reviewFanout`, so a crash in
  between never leaves `reviewing` with nothing to drive it.
- **Address Findings → Verify.** Address Findings submits a typed `fix-result` and Verify reads
  it as an evidence frame, not the Address Findings session's last assistant text
  ([review preparation](review-preparation.md#the-address--verify-handoff)). The
  accepted result is kept, bounded, on the Address Findings session (`fixResult`, marked
  by `addressReportKind`), and the Address Findings inspector shows it above the
  transcript as a collapsed "Address Findings report": complete or incomplete, files,
  checks (failed ones counted), then the summary, checks, files, notes and
  limitations (`PipelineAddressFindingsReport.tsx`). Its submission status reads as for
  the other typed stages. An Address Findings session from before the typed handoff has
  no report there, and Verify reads its text as before. A round with no Address Findings
  (a clean review) gives Verify no report.
- **Fan-out.** The live pass reads `reviewFanout.reviewers`: status, queue
  position ("queued · #3 of 7"), "starting", the error, issue counts. Reviewers
  with no session yet are nodes too. Once the pass is retired, each reviewer
  session keeps how it ended (`reviewerOutcome`), a bounded `error` (2,000
  characters) and per-severity `reviewIssueCounts`; older records without them
  fall back to the session status. Failed reviewers without a mirrored session row
  are retained in the consolidation session’s `sessionlessReviewers` summary
  (at most one entry per panel slot, bounded model and error text), so their
  model and diagnostic remain inspectable after the live pass is retired.
  Blank provider diagnostics use a nonblank fallback so failure snapshots
  remain valid. A retried reviewer replaces its failed
  attempt in the same slot, and the inspector says how many earlier attempts
  there were.
- **A reviewer that could not start.** A reviewer that fails before its first agent
  turn is accepted (a missing bridge or CLI, unavailable bridge auth) carries
  `startFailed` on its live record. The session ID alone does not prove startup: `agentStarted` records acceptance.
  A retired pass's `sessionlessReviewers` preserve `startFailed` explicitly;
  entries without it retain a generic failure label. Its node and inspector read "Could not start", and a
  notice above the graph names each such reviewer of the newest pass, with
  its agent and error (`ReviewerStartFailureNotice`). The Multi Review
  overview shows the same notice. The rest of the panel carries on, and each
  round tries the reviewer again ([to-do 1090](../todo/coordinator-and-multi-review/1090-cursor-reviewer-cannot-start-on-standalone-backend.md)).
- **Read-only review.** Reviewers and consolidation run in provider read-only
  mode, as Multi Review's do. A worktree that moves under them marks the review
  stale and stops nothing. Verify must leave HEAD and the Git-visible paths as it
  found them: the backend checks at submit time, so it can undo a change within
  its turn, and again when it uses the verdict, and a change fails the step
  ([review preparation](review-preparation.md#read-only-reviewers-and-the-git-guard)).
  A step whose starting Git state cannot be observed fails before any of its
  sessions starts.
- **Stops.** The current session carries a pause, failure or cancellation. A
  stage that failed or paused before its session existed gets a node of its
  own; a fan-out that failed without consolidating carries it on
  Consolidation.
- **Ticket.** Always first and complete, no elapsed time. Its third row shows
  the pipeline creation date in local time, explicitly labelled "Started" and
  included as a start time in its accessible name. Missing or invalid creation
  dates omit this row. The inspector shows the stored `taskSnapshot` (title,
  description, acceptance criteria, reference images, comments; Markdown
  rendered; empty sections omitted), never the bridge prompt. A pipeline without a snapshot shows a placeholder. When the
  board has already loaded the Kanban ticket and it now reads differently, a
  note says so; nothing is fetched for it.
- **PR.** The environment's pull request (`prUrl`, `prState`) and the PR
  monitor's `checkSummary`, shown only once the pipeline has a Ship session that
  opens one (`pipelineReachedPullRequestStage`; an older PR on a reused
  environment is not this pipeline's). The monitor owns polling and its bounds;
  the graph adds no read.
- **Delivery without a PR.** The line follows the decided policy, or before
  Verify passes the last one seen, so the steps ahead match what the ticket says
  now ([Delivery after Verify](#delivery-after-verify)). `push-no-pr` titles the
  Ship node and its column "Push". `commit-only` draws no Ship at all. Either way
  the last node reads "No PR" and says what happened ("Branch pushed, no PR
  opened", "Commits kept in the environment"); its inspector has the whole
  sentence (`pipelineDeliverySummary`).

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
   after it ran when a runtime was recorded. The Ticket instead uses a dedicated
   **Start** row (`data-flow-node-row="start"`): `Started {local date/time}`,
   rendered as a `time` element, separate from elapsed runtime and tokens.

So a node that has not run (or a placeholder ahead) has two rows, and a
running node three. **Decision:** a finished node keeps its final duration and
tokens on row 3 rather than moving them onto row 2. That keeps the runtime in
one place, a node's height unchanged when it finishes (so nothing on the graph
moves as a stage completes), and the detail row free for the model and the
severity chips. The cost is a finished node 18 px taller than a two-row one.
Validation chips and the PR's checks are further rows under the face.

For legacy completed sequential stages without a recorded end, the graph uses
the earliest qualifying start in the nearest later column that has one,
retaining boundaries from all attempts even when retries replace visible nodes.
Parallel reviewer ends are never inferred from consolidation: a reviewer may
finish earlier than its peers. Failed/stopped nodes and final stages without a
later start keep their end unknown.

`flowNodeHeight` turns those rows into the height the wide layouts give a
node (64 px for two rows, 82 px with the runtime row, plus 28 px of chips or
20 px of checks; the Ticket's start row also adds 18 px). Both
`pipelineFlowLayout` and `multiReviewFlowLayout` centre a taller node on the
same line as its neighbours, so edges still meet every node at its vertical
centre. Node widths do not change. The stacked column lays nodes out by their
content, so it needs no heights, and Fit measures what was laid out.

A running node whose provider has not reported usage yet shows a dash in place
of the count ("2m 35s · —"); its accessible name and the inspector leave the
count out rather than calling it pending.

### Token usage

The graph reads each node's tokens from `PipelineSession.tokenCount` on the
pipeline record, never from a transcript. The backend writes it for every stage
session: fan-out reviewers mirror their reviewer record, and every other stage
(Build, Rework, review-package preparation, a single review, Consolidation,
Address Findings, Verify, Ship, conflict resolution) is metered by
`recordPipelineSessionUsage` from the same provider status read that drives
the stage. The provider's cumulative `contextUsage.sessionTokens` is used
when the status read carries it (the Claude and Codex bridges update it while
a turn runs; others report it when their bridge does); a provider that meters from its transcript
(OpenCode) is metered from the transcript read the pass already made. The count
only grows, is saved on the transcript persist cadence while the turn runs and
with the final transcript when it ends, and a meter that fails never fails the
stage. The validation run of a Prepare node, the Ticket, Setup and the PR run
no agent and have no tokens.

## Per-stage instructions

Every step can carry the user's own instructions: `BuildStepConfig.instructions`,
at most 16 KiB of UTF-8 (`MAX_BUILD_STEP_INSTRUCTIONS_BYTES`). The guard,
renderer and stage mapping live in
`packages/protocol/src/build-pipeline-stage-instructions.ts`
(`@orkestrator/protocol/build-pipeline-stage-instructions`); `isBuildStepConfig`
rejects a longer text, so every launch input that carries steps (the launcher,
the New Environment dialog's feature option, the coordinator, the public
`build.launch` action) is bounded by
the same check.

- **Prompt.** A stage with instructions gets one framed section after its own
  contract: "**Additional instructions from the user** for this stage…" and the
  text inside `<user-stage-instructions>` … `</user-stage-instructions>`
  (`withBuildStepInstructions`). The preamble says they refine the task and do
  not change the stage's result format, permissions or rules. A marker typed
  inside the text is escaped so it cannot close the frame. Only the
  session-wide unattended-input note follows it. A step without instructions
  gets a prompt identical to before, byte for byte.
- **Which step a stage reads.** Build, Review (single reviewer), Address Findings,
  Verify, Ship and conflict resolution read their own step
  (`pipelineStepInstructions` with `stepKeyForSessionPhase`). Rework reads
  Build's, as it runs on Build's model. Each fan-out reviewer reads its own row
  in `reviewers` (`pipelineReviewerInstructions`), after the panel section, so
  the panel's shared prompt prefix stays byte-identical. The dedicated package
  preparation and the fan-out consolidation read `reviewPreparation`
  (`pipelineReviewPreparationInstructions`); without a preparation step they
  borrow the Address Findings model but not its instructions. On the
  single-reviewer path the build or fix turn prepares the package inline, under
  Build's instructions.
- **Record.** The backend stores them trimmed on `steps`, `reviewers` and
  `reviewPreparation` (`normalizeSteps`, `normalizeReviewers`); blank text is
  dropped. Every stage prompt is rebuilt from the record, so a restart, a
  rewind, a retried stage, a fresh review panel and a backend restart all read
  the same text. Resume, reminders and repairs continue a session that already
  has the opening prompt and do not repeat it. A pipeline environment from the
  New Environment dialog's feature option that pins Address Findings but not Verify copies the Address Findings model to Verify, not its
  instructions.
- **Launcher.** Each step card in `BuildLaunchDialog.tsx` has a collapsed
  "*Step* instructions" field (`BuildStepInstructionsField.tsx`) with a byte
  counter. Over 16 KiB the field is marked invalid and Start build is disabled.
  The Build card notes that Rework uses them too. Instructions belong to one
  launch: the dialog starts empty every time it opens, and saved build defaults
  (action defaults) hold models only.
- **CLI.** `orkestrator build launch TICKET --instructions STAGE=TEXT` (or
  `--instructions-file STAGE=PATH`, `N=…` for reviewer row N) sends them
  through the public `build.launch` action, which layers them over the saved
  defaults as the coordinator does; `build get` reports each step's
  `instructionsBytes`, never the text
  ([public-cli.md](public-cli.md#build-pipelines)).

## Reviewer lenses

Each reviewer can have a focus, a lens (`BuildStepConfig.lens`, the shape and
bounds of `ReviewerModelSelection.lens`; see
[reviewer lenses](review-preparation.md#reviewer-lenses)). Only the review step
and the `reviewers` rows keep one: `normalizeSteps` drops a lens from every
other step and `normalizeReviewPreparation` from the preparation step.

- **Prompt.** A fan-out reviewer's prompt is the shared package prompt, its
  panel section, its "**Review focus**" section and then its own instructions
  frame, so the prefix before the panel section stays byte-identical across the
  panel. A single reviewer has no panel section; the review step's lens follows
  the review contract and precedes the step's instructions.
- **Record.** The stored row keeps the text the launcher copied. Each fan-out
  pass copies it onto the reviewer's record (`reviewFanout.reviewers[i].lens`),
  so a retried reviewer, a fresh pass after a restart or rewind, and a backend
  restart render the same focus. The consolidation evidence carries each
  reviewer's label as `focus`.
- **Defaults.** `buildPipelineConfiguredDefaults` gives each reviewer row the
  saved focus of its Multi Review position (`multiReview.reviewerLenses`), so
  the Build button, the New Environment dialog's feature option, the coordinator
  and the CLI's `build launch` start build pipelines with the same focus as the
  Multi Review button;
  `build launch --reviewer … --focus N=TEXT` replaces it per row.
- **Launcher.** Each reviewer card in `BuildLaunchDialog.tsx` (and the single
  Review card) has a Focus select (`ReviewLensField.tsx`): no focus, a saved
  preset, or custom text. It opens on the position's saved focus; an
  incomplete custom focus disables Start build.

## Header and key information

The tab header names the ticket and, under it, the phase, the build agent,
"N of M steps" and the elapsed time (on their own line on a phone). On its
right is one row of equal icon buttons: the pipeline controls (retry, restart,
pause, resume, cancel), then **Key information**, then the graph's collapse
toggle. `PipelineFlowView` still computes the progress and the toggle and
renders them through portals into the header (`headerSlots`); a review pass
opened as its own tab has no pipeline header and keeps both inline above its
graph. There is no
banner pointing at the review report: a review's outcome is on its node, in
its inspector, and in the key information.

Key information is the running brief a reader opens instead of reading the
transcripts. It is `BuildPipeline.keyInformation`
(`@orkestrator/protocol/build-pipeline-key-information`), and the button opens
it as a panel floating over the tab (`PipelineKeyInformation.tsx`; Escape, the
close button or a click outside closes it). Its sections, each shown only once
written:

- **Summary**: the change as a whole, in plain language for a reader who does
  not know the code, in a few short paragraphs. A brief written before this
  section existed has none and opens on its Problem or Objective.
- **Problem** or **Objective**: `framing` is `problem` by default, `objective`
  when the ticket adds or changes something that was not broken.
- **Context**, **Solution**, **What was done**.
- **Decisions**: each decision with every option, its pros and cons, the
  option chosen and why.
- **Not done or needs further work**, **Tests** (each with its result).
- **Review issues**: each round's issues, how each was handled, and its status.
- **Verification**: each round's verdict and checks, with what failed.

The panel lists the written sections' headings in a column on its left, or in
a row above the brief when the panel is narrower than 32rem. The list sits
outside the brief's scrolling column, so it stays put while the brief
scrolls. Choosing a heading scrolls only that column (never the page under
the panel) to the section, smoothly unless the user prefers reduced motion,
and the heading of the section being read is marked current
(`aria-current="location"`). The key information tab's "On this page" list
uses the same behaviour (`key-information-section-nav.ts`). When Context and
Solution share a row in the wide tab, scrolling within that row keeps its
selected heading current. Entering the row from another section defaults to
its first heading, Context.

Summary, Problem or Objective, Context and Solution are laid out as paragraphs
and lists (`key-information-blocks.ts`) in both the panel and the tab: a blank
line starts a paragraph, and lines starting `- `, `* `, `• `, `1. ` or `1) `
become a bulleted or numbered list. The Build prompt and the tool's field
descriptions ask agents to write that way. Text recorded as one unbroken run,
as older briefs were, is regrouped into paragraphs of a few whole sentences
once it is 480 characters or longer, so it still does not read as one block;
text with any line break is shown as written.

Stage agents keep it through two agent tools, `get_key_information` and
`update_key_information` (`build-pipeline-key-information-tools.ts`). They are
listed only to a credential whose environment a build pipeline owns, on the
general agent server and on a stage turn's workflow-result server, so a stage
reaches them on whichever connection its turn runs. Codex approves them
without asking, as it does the mail and artifact tools: they write only the
pipeline record. An update names the sections it replaces; `issues` and
`verification` replace the current round's entries only. The backend records
it as the running stage and round, under the pipeline lock, and refuses one
that waits more than 30 seconds behind a supervisor pass (never applying it
later). Once admitted under the lock, the tool awaits the persistence result;
the wait timeout cannot report a committed write as failed. The Build, Rework, Address Findings and Verify prompts end with stage-specific
guidance on what to record (`keyInformationInstruction`); Review and the PR
stages do not keep it.

The backend also writes two sections itself, so they are never empty because
a stage skipped the tool: an accepted review records its round's issues as
open (a repeated review replaces them only while none has been worked on), and
a Verify verdict sets its round's `passed`, keeping Verify's own summary and
checks or deriving them from the criterion results. A restart that rewinds to
an earlier round drops what later rounds recorded and the verification of the
round it reruns. Restarting at or before Review, or explicitly retrying Review,
also discards that round's superseded issues; restarting Address Findings or a later
stage preserves the round's issues and resolutions. On any rewind or review
retry, narrative sections and update history are cleared conservatively:
they have no per-attempt snapshots to restore, so stages rebuild the brief
instead of showing superseded work as current. Every field is bounded
(`KEY_INFORMATION_LIMITS`, about 200 KB at worst) and checked by
`isBuildPipeline`.

`updates[].sections` accepts only `KEY_INFORMATION_SECTIONS`, and a value a
release does not know fails its whole pipeline snapshot. A new section therefore
stays off that list until the support window's floor reads it: `summary` is
stored and shown but not named in update history, so an older renderer or a
downgraded backend ignores the field and keeps the pipeline.

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

The message box (`PipelineMessageComposer`) treats a message the way a native
agent tab does. Queued messages show as the same strips above the box
(`QueuedPromptStack`), each with Steer (while a turn that can be steered is
running), Edit and Remove; the pipeline has no reorder dialog, so there is no
View all. With the Auto-steer setting on, a plain message sent while such a turn
runs is queued and then steered out of the queue, the same path as the Steer
button (`steer_queued_build_pipeline_message`). Commands stay queued, because the
pipeline has no catalogue to classify them against. The transfer happens under
the pipeline lock: a message the agent refused, or that arrived after the turn
ended, stays queued in its place; one whose delivery cannot be confirmed leaves
the queue and returns to the box with a warning, because the queue would
otherwise deliver it a second time. Before contacting the provider, the backend
saves the message and stable request id in `pendingUserSteers`, outside the
dispatch queue. A crash or failed result save leaves that attempt retained for
inspection, never automatically retried. Confirmed delivery removes the attempt;
definite non-delivery restores the original queue order. Retained attempts are
bounded by the queue count and message length limits; capacity refuses further
steering rather than evicting uncertain text. The composer shows retained text in
expandable notices, including after reload, and keeps an occupied draft intact.
If typing races an Edit response, the withdrawn text appears in a retained notice.
Validation against a fixed snapshot disables sending and steering, while queued
messages can still be edited or removed. A typed `/steer` still goes straight to the
live turn (`steer_build_pipeline`).

A stage whose turn ended while background work it started is still live stays
`running`, because advancing would start the next stage against a worktree that
work may still change. `awaitingBackgroundWork` on the session says no model turn
is in progress: the footer reads "is waiting on background work" rather than "is
thinking", and Steer and Auto-steer are off. A queued message does not wait for
that work. The supervisor sends it as a new turn into the same process, and the
stage stays held if the work is still live when that turn ends. A pending review
retry still waits, because it replaces the session. If the bridge refuses the send
(it answers 409 to a prompt that changes a launch-only setting while background
work is live), the message returns to the queue, nothing about the stage changes,
and it is tried again a minute later; the stage is never failed for it.

Actions sit in each node's context menu and in the inspector: open the session
(Open Rework session on a Rework node), open the review pass as a Multi Review tab,
retry a failed reviewer (`retry_build_pipeline_reviewer`), stop one reviewer
(`stop_build_pipeline_reviewer`), restart one reviewer
(`restart_build_pipeline_reviewer`), retry the failed
step (`retry_build_pipeline_stage`), restart from a step
(`restart_build_pipeline_step`), prepare the review package again
("Prepare package again", see [Restarting a step](#restarting-a-step)),
rewind the code to a step ("Rewind code to here…", see
[Rewinding the code](#rewinding-the-code)), skip the running step
(`skip_build_pipeline_step`), view the PR, and pause, resume or cancel the
pipeline. The header keeps its controls.

Skipping moves on without the step's result. Skipping validation stops the
checks and seals the review package with the results they had (a paused,
already-cancelled run included), and the Tests view's "Stop tests and
continue" does the same. Skipping an agent step stops its session and opens the
next one: Build or Rework goes to review preparation, a review or Address Findings to
Verify, and Verify to delivery. Review preparation and the PR steps cannot be
skipped; skipping Verify still follows the ticket's delivery policy. The skipped
node reads "Skipped".

"Stop reviewer" ends one queued, starting or running reviewer of the running
review and keeps the rest of the panel, where "Skip review" ends the review.
The reviewer reads "stopped", its session and transcript stay, and its result
slot closes, so a late submission is denied. As in Multi Review the abort is
best effort, because the usual reason to stop a reviewer is that it is not
responding. Consolidation runs from the others' reports; stopping the last
reviewer with no report fails the stage. A queued reviewer has no session, so it
leaves no node once the pass is retired.

A stop holds for the pass, across a pause, a resume, and a retry of another
reviewer or of consolidation (`stoppedReviewerIds` on the pipeline, cleared with
each new pass). Only Restart reviewer undoes it, or a stage retry of a panel with
no report left to consolidate.

"Restart reviewer" (`restart_build_pipeline_reviewer`) runs one reviewer again in
any state, as in Multi Review. In the running review its peers carry on and a
started consolidation is discarded. Once the pipeline has moved past the pass, it
rewinds to the panel: the steps after it are superseded and the others' reports
stay in use. Only the current round's panel can do this, because a later round
has changed the code, and "Restart from here" reruns the whole pass.

A worktree that moves during a review marks the review stale and stops nothing
([review preparation](review-preparation.md#read-only-reviewers-and-the-git-guard)):
a notice above the graph says so, from `reviewFanout.snapshotStale` and then the
session's `reviewWorktreeChanged`. A reviewer's node shows its focus, and its
inspector the findings it has reported so far through `report_finding`.

The review pass tab is a `multi-review` tab whose data names the pipeline and a
`pipelinePass`; it renders the same view narrowed to that pass. Layout restore
keeps it while the pipeline exists.

## Restarting a step

"Restart from here" (`restart_build_pipeline_step`) on any live step — Build,
Rework, Prepare or its validation, a reviewer (the whole review pass reruns),
consolidation (it alone reruns while its round's reports survive, otherwise the
whole pass), Review, Address Findings, Verify, Ship or conflict resolution — rewinds
the pipeline to that step's own round and position and runs it again. The
backend (`restartLocatedStage` in `build-pipeline-service-lifecycle.ts`, rules
in `build-pipeline-rewind.ts`):

- **Rewinds the round.** `iteration` becomes the step's own, so the rounds
  after it are available again: restarting round 1's Verify after round 4
  failed runs Verify 1, then on failure Rework 2, Verify 2 and so on up to
  `maxIterations`.
- **Keeps the code.** The worktree and branch are not reset; the rerun and
  every later step work on the current code, later rounds' commits included.
  Rewinding the code itself is the separate, confirmed action described in
  [Rewinding the code](#rewinding-the-code).
- **Invalidates what came after.** Every live session at or after the point
  (same round and later step, or a later round) gets `supersededBy` (the
  `PipelineRewind.id`) and `supersededAt`. A rewind into an earlier round also
  invalidates the review package, validation run, structured review and verdict,
  because they describe later code; a step whose inputs are gone reruns from
  the earliest step of its round that rebuilds them (Review prepares the
  package again). Address Findings reruns alone on its round's own accepted report
  (`roundReviewReports`, below); only when that copy is gone does it rerun
  Review, or prepare the package first when that is gone too. Verify
  sessions keep their own verdict (`verificationResult`,
  `verificationFeedback`, bounded), so a restarted Rework gets the verdict that
  ended the round before it. Legacy records without that session's verdict use
  generic feedback when rewinding to an earlier Rework, never the last round's rationale.
- **Treats superseded sessions as history.** They are never the current
  session (`sessionForCurrentPhase`), never the source of a fix baseline (a
  same-round restart still carries the first attempt's baseline), an address
  handoff, a review report owner or a Multi Review evaluation; all their
  result slots are closed `superseded`, so a late tool submission is denied.
- **Records the rewind.** `rewinds` (at most 50) says when, from which phase
  and round, to which round and step, which session was named and how many
  sessions were superseded. An invalidated validation run is retained on that
  rewind and remains readable in its previous-attempt inspector (bounded by the
  same 50-rewind limit). A repeat of the same request (a double click, a
  retried command) is a no-op; restarting a superseded step is refused. Validation
  rewinds record their replacement run ID: repeats naming the original validation
  run, or the current-step control while its replacement is planned/running,
  keep that generation. Selecting the live validation node explicitly can restart it again.
  Validation-only history is placed at its rewind boundary, before replacement
  reviewers, and its inspector and context menu expose no restart actions.
- **Works from `failed` and `complete`.** The phase is set and the request
  persisted in one locked write, so the supervisor and recovery pick it up as
  for any active pipeline. Consuming the request moves a Kanban ticket back to
  In progress; a durable pending flag and retry deadline retry Kanban failures at
  most once every 30 seconds, including across backend reloads, without
  dispatching the restarted stage again or writing on each intervening tick. The next terminal outcome
  reconciles it again and its comments dedupe. A Ship after an earlier Ship is told the existing PR URL and updates
  (or reopens) that PR instead of creating one. Ship fails if the provider finishes
  with the PR still closed. A pipeline whose PR has merged
  refuses restarts.

`restart_build_pipeline_current_step`, `retry_build_pipeline_stage` and
`retry_build_pipeline_review` keep their semantics; restarting the current step
supersedes only that step's session. Restarting a Build or Rework that also wrote
the package plan reruns the Build or Rework; the dedicated preparation session
restarts preparation alone. On the single-review path, where the Build or Rework
wrote the plan and there is no dedicated session, "Prepare package again" on
that Build or Rework node, or on the Prepare node holding its checks, sends the
stage ID `review-package:<sessionKey>`: the plan's turn stays live, everything
from package preparation on is superseded, and a dedicated preparation session
prepares the package from the turn's result. A repeat while that preparation
is still pending or running is a no-op; a session that wrote no plan is
refused.

**Per-round review reports.** `structuredReview` holds only the newest
accepted report, and the per-session `reviewReport` copies are discarded at the
next review attempt. So each accepted consolidated report (single review or
fan-out consolidation) is also kept in `roundReviewReports`, one entry per
round naming the session that filed it, at most
`MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES` (1 MiB) of serialized reports in
total: older rounds' copies give way first, and a report larger than the
budget is not copied. A copy counts only while its session is the newest live
review-phase session of its round, so a later retry of that round, a
retried reviewer that discarded the consolidation, or a rewind that superseded
the review makes it stale; stale copies are pruned on every rewind and every
new copy.

**Presentation.** Each rewind's superseded sessions are one greyed, dashed
"Previous attempt" node (kind `attempt`, column marked `superseded`) where the
restart rewound to, followed by the rerun to the right. Interleaved rewinds
collect all sessions with the same rewind ID into one group at its earliest
session position. The live line routes
over it (`route: "bypass"`; the stacked column draws the bypass beside it),
and the attempt branches off the step before it. Its inspector says when and
from where the restart rewound and lists the steps; "Show steps" expands it
into greyed nodes titled by round ("Rework · round 2", reviewers of one pass in
one column, including every retry), each selectable with its transcript readable and a "Superseded by
a restart" note, and no restart or retry. Expansion is renderer-only view
state (`flowGraphViewStore.expandedAttempts`, at most 50). Superseded nodes are
left out of the step count, review-pass numbering, stop placement and the
followed selection. The record fields are generic (any renderer can group
sessions by `supersededBy` and read `rewinds`).

### Rewinding the code

"Rewind code to here…" (`rewind_build_pipeline_code`, logic in
`build-pipeline-code-rewind.ts`) resets the branch to the commit a step started
from, then restarts the pipeline from that step exactly as "Restart from here"
does. Every stage session started by the supervisor records `headAtStart`
(Verify and a packaged single Review reuse their read-only guard baseline;
other stages probe once, best effort);
fan-out reviewers and consolidation do not, and a step without it has no
action.

1. **Preview.** Opening the action reads
   `preview_build_pipeline_code_rewind`: the target commit, the current HEAD,
   the commits `target..HEAD` drops (newest first, at most 50 with bounded
   subjects, plus the total), the upstream branch and how many of its commits
   `target..@{upstream}` the reset leaves behind, the pull request when the
   pipeline shipped one, and a `blocked` reason when it cannot run.
2. **Refusals.** It is blocked, and the confirmed request refused, while the
   pipeline runs a step or validation (pause it first), when the worktree has
   uncommitted changes (a hard reset would destroy them; the preview names up
   to 20 paths), when the target is gone or no longer an ancestor of HEAD, when
   the pull request has merged, and when the backend has no
   `environmentGit` (the option `index.ts` wires to the environment's command
   runner; it is deliberately not a backend command a renderer could call).
3. **Confirm.** The confirmation names the commits and carries the HEAD the
   preview read (`expectedHead`); a branch that moved since is refused. Inside
   the pipeline lock, before any state changes, the backend checks again,
   keeps the old tip at `refs/orkestrator/build-pipeline-rewinds/<pipeline>/<rewind>`
   (`git update-ref`), and runs `git reset --hard <target>`. A refused request
   leaves the record untouched. An admitted one journals the rewind's `code`
   (from, to, dropped commits, backup ref, upstream and its dropped count) with
   `pending` before Git changes, and nothing else runs on the pipeline until
   the reset finishes; a repeat of the same request is a no-op like any
   restart.
   In a container environment every Git command runs as
   `docker exec -w /workspace <container> git …`. When the container is
   paused, stopped or gone, the refusal says so (`EnvironmentUnavailableError`
   from `createPipelineEnvironmentGit`, which reads the container's state
   rather than passing on Docker's text). A reset already journaled is
   retried on every supervisor pass, logged once per reason, and each control
   in the meantime says the rewind has not finished; the reset completes, and
   the step starts, once the container answers again.
   Deleting the pipeline is the one control that does not wait: inside the
   pipeline lock it drops the record, with its unrun reset, without cancelling
   first (admission required an idle pipeline, so there is nothing to stop).
   That is the way out when the reset can never run, for example because the
   workspace was recreated or the branch moved by hand. Pause and cancel still
   wait for the reset.
4. **Pushed commits and the pull request.** When the upstream had commits the
   reset dropped, every Ship until a live Ship completes after the rewind is
   told to push with `git push --force-with-lease` (never plain `--force`, never
   pulling the remote commits back) and still updates, or reopens, the same
   pull request. The pull request then shows the rewound history.

The previous-attempt inspector says the code was reset, from and to which
commits and how many commits it dropped, and names the backup ref.

`retry_build_pipeline_reviewer` reruns one failed reviewer of the current pass,
keeps the rest of the panel, discards a started consolidation, and resumes a
review that failed or paused. The failed attempt's session stays as history
under its key; the retry gets `…:attempt-2`.

## Delivery after Verify

`deliverVerifiedWork` (`build-pipeline-service-recovery.ts`) acts on the ticket's
policy when Verify passes or is skipped; the policies and who chooses them are
in [tickets.md](tickets.md#delivery). The decision is saved before creating a
Ship session, so a failed session creation and retry keep the same policy.
Resuming a paused push-only Ship explicitly forbids opening or editing a PR.

- **`open-pr`** starts the PR stage as always.
- **`push-no-pr`** starts the same Ship stage (`pr` session, `creating-pr` phase,
  the Pull request step's model and instructions) under
  `BRANCH_PUSH_SESSION_LABEL`, with `pushBranchPrompt`: commit what remains, push,
  open nothing. Retry, restart, pause, usage and the transcript are Ship's, and a
  code rewind's force-with-lease rule still applies. It is an agent turn rather
  than a backend push because Verify allows uncommitted leftovers and only a turn
  can judge which are part of the work. It cannot be skipped. When the turn ends,
  the backend asks origin (`branchPushState`, `git ls-remote`) whether the branch
  has HEAD; if not, the stage fails and can be retried, so the run cannot claim a
  push that did not happen. The labels read "Pushing branch", "Retry Push Stage"
  and "Restart Push Stage", and the board card "Pushing".
- **`commit-only`** starts nothing. The pipeline completes at once, recording
  how many uncommitted paths remain.

A run without a PR is a clean success: `phase` is `complete`, and the Kanban
ticket moves to Review as usual, with a comment saying what happened. Compared
with a run that opened a PR, it never reaches `detect_pr`, the conflict stage or
`pr_monitor_watch`, and writes no `prUrl` to the ticket or the environment.
Checks that a pull request belongs to this pipeline count only a Ship that opens
one, so an older merged PR on a reused environment blocks neither a restart nor
a code rewind. A later Ship that does open a PR still sees the existing URL.
A coordinator that started the build reads the same sentence in its completion
notice.

If an earlier attempt of the run opened a PR and a restart then ends in
`push-no-pr`, the push updates that PR, which stays open, and the last node's
inspector links it. Nothing closes a pull request.

## Notes

Notes is the last step on the line, after the PR (or the "No PR" outcome). It
is not an agent stage: it has no session, costs nothing and cannot fail. The
node (`kind: "notes"`) is drawn ahead like the PR and is complete when the run
is, which makes it the last step reached: a finished run opens on Notes, where
the follow-ups are, unless the user has picked another node. Arriving there also
scrolls to it (`landOnSelection`), at any width and over a remembered pan: the
stacked column puts Notes at the top with its inspector below, and a tab hidden
when the run finished lands when it is shown. It happens once per arrival, so the
reader's own scrolling survives another pane taking over. On a failed run it
stays readable, its status says "So far", and selection stays on the step that
failed. Only a cancelled run that never shipped omits it.

Its inspector (`PipelineNotesView`) shows the whole key information document
(`KeyInformationDocument`, the same one the key information tab renders), led
by **Needs a look** at the top, ahead of the at-a-glance tiles and the summary.
It opens collapsed to its header and count; only the header toggles it, so the
items inside stay selectable, and each mount starts collapsed again. With
nothing flagged it is a one-line note instead. The list comes from `pipelineFollowUps`
(`@orkestrator/protocol/build-pipeline-notes`), a pure reading of the record:

- criteria the newest live Verify marked `not-checked`, with what was missing;
- the brief's `notDone` entries;
- review issues still `open` or `partially-resolved`;
- tests whose result is not `passed`.

A double click on the node (Enter, or its "Open notes in a tab" action) opens
the same reading on a full pane: the `key-information` tab with `view: "notes"`.
A pipeline has one such tab, separate from its key information tab, which keeps
showing the brief alone. Both keep only the pipeline id and read the record, so
they follow every update and survive a reload.

A finished run opens that tab and selects it. The backend does this when the
pipeline completes (`ensureBuildPipelineNotesTab` in
`apps/backend/src/core/storage-sessions.ts`, called from the recovery
module's `complete`): it adds the notes tab to the environment's authoritative
layout, in the pane holding the pipeline tab, else the active pane, and makes it
that pane's tab and the active pane. So a run that finished while no client was
watching it (the app closed, the window on another environment, or the run on
another node whose pipelines this window had not loaded yet) still lands on
its notes: a client hydrating the environment adopts the backend's selection.
An Electron window keeps its own selection, so it follows the notes tab once,
when a tab marked `completionPublished` first arrives in that window
(`applyCompletionNotesArrival` in
`apps/web/src/lib/pane-layout-authoritative.ts`), the way it follows a newly
published setup terminal. Manual Notes openings have no completion marker and
leave other windows on their selected tab. A user who then picks another tab is
not pulled back.
Completion is the only trigger, so a reload never reopens old notes.

The renderer also reacts to a completion it observed
(`apps/web/src/lib/build-pipeline-completion-notes.ts`): a pipeline the store
held in an earlier phase arriving as `complete` opens or focuses the same tab
without waiting for the layout round trip. Both derive the tab id from
`keyInformationTabId` (`@orkestrator/protocol/pane-layout`), so they merge into
one tab. An open notes tab is focused rather than duplicated; a full layout
opens nothing, leaving the Notes step selected.

The Ship stage passes the same list to `prPrompt`, which has the description
carry a `## Needs a look` section, so the person merging sees it. Only the
pipeline's Ship stage does this. A graph's `pull-request-description` builder
does not receive the list yet.

## Worker mailboxes

Every session on the line is a worker with its own agent mailbox, addressed
`pipeline-worker:<sessionKey>` in the pipeline environment
([coordinator](coordinator.md#pipeline-worker-mailboxes) has the whole
contract). A node is one worker: each reviewer of a pass, Prepare's package
preparation, Consolidation, Address Findings, Verify, Rework, Ship and conflict
resolution, in every round, and a "Previous attempt" node's sessions are
cancelled workers. The pipeline tab adds no tab, control or read for them: the
graph still reads only the record, and the workers list (`pipelineWorkers`,
`packages/protocol/src/pipeline-worker-mail.ts`) is derived from the same
record by the mail directory and by `get_build_pipeline`.

What the pipeline does for mail:

- Mail queued for the running session becomes that session's next turn when
  its turn ends, before the supervisor advances the stage, through the same
  pending prompt attempt a queued user message uses. The attempt's request id
  is kept on the session (`mailDeliveries`, newest 20).
- A coordinator's `deliverNow` is steered into the running turn under the
  pipeline lock, as the tab's own steer is; a steered build or fix drops its
  preparation result the same way.
- A fan-out reviewer and the consolidation take their queued mail as a
  follow-up turn before their result is accepted, with a fresh result key.
  Mail during fixed-snapshot validation cancels and archives that validation
  run before the writable mail turn; preparation and validation then certify
  the new state.
- Every turn carries its worker's own mail identity: the workflow-result
  server on a tool-mode turn, otherwise a credential scoped to the worker's
  mailbox, or on OpenCode a signed `mailCapability` in the turn's system
  instruction (`BuildPipelineContext.workerMailTurn`).
- A worker's own transcript is its session's committed transcript, which the
  coordinator reads with `get_tab_transcript` and the worker's address.

## Stage table and the built-in template

`BUILD_PIPELINE_STAGES` (`apps/backend/src/core/build-pipeline-stages.ts`)
lists the stages in the order a run meets them, each with its place in the
rounds, its workspace boundary (`write`, `read-only`, `guarded`, `system`)
and the result it submits. The supervisor takes session labels, phases,
result kinds and the read-only and guarded boundaries from it. The built-in
Build Pipeline graph template (`@orkestrator/protocol/graphs/builtins`,
plan item 108) describes the same stages, and
`graph-builtin-templates.test.ts` pins the two together with the routing
rules (`stageAfterReview`, `verificationPassed`,
`pullRequestNeedsConflictResolution`), the default and maximum iterations,
the reviewer cap and the saved step defaults. Change a stage, a rule or a
bound and that test fails until the template says the same.

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
  and are superseded by their first restart like any other. Sessions written
  before `headAtStart` existed offer no code rewind; records without
  `roundReviewReports` rerun Review when an earlier round's Address Findings restarts.
  Review sessions without a `validationHeadAtStart` and panel passes without
  `reviewFanout.workspaceBaseline` predate the read-only guard and are not
  certified against one.

Follow-ups: [0315-build-pipeline-flow-graph.md](../todo/coordinator-and-multi-review/0315-build-pipeline-flow-graph.md),
[0405-build-pipeline-rewind-follow-ups.md](../todo/coordinator-and-multi-review/0405-build-pipeline-rewind-follow-ups.md).

## Completed interactive Build attempts (internal foundation)

The backend-only `startFromCompletedBuild` entry point can admit an already
finished Build attempt in a running existing environment. It records the
original provider session, a bounded copy of its transcript, its prompt tab
identity (`adoptedFromTabId`), the committed baseline for code rewind, and a
Build-authored key-information patch. The first display round is 1 (stored
iteration 0).

Admission precedes supervisor work. Normal source linkage and environment
configuration still run, then the supervisor skips workspace setup and Build
and enters the usual Review preparation path. It sends no turn to the original
session. Restarting Build uses the ordinary ticket-based session path and
retains the superseded original attempt and transcript.

The manual Auto-pipeline launch below supplies this admission data after the
user reviews its draft.

### Manual Auto-pipeline promotion

The manual Multi Review configuration dialog offers **Auto-pipeline** for an
open interactive native agent tab in a prompt environment. A picker identifies
the transcript when several tabs are open. Running turns disable drafting with
an explanation. Existing pipeline environments and coordinator or pipeline
review launchers do not offer promotion.

A separate read-only session uses the saved Build agent, model and effort. It
receives the selected transcript and the branch diff against the environment's
base commit. Its `submit_auto_pipeline_draft` result contains the ticket and the
Build handoff together. It never sends a turn to the original tab. The backend
bounds the transcript, diff and result, and refuses a changed checkout.

The user edits the title, description and ordered acceptance criteria before
confirming. Generated Build notes and the pending paths are shown read-only.
Cancel creates no ticket or pipeline; a failed draft offers retry and plain
Multi Review. Drafts and confirmation receipts are backend-owned SQLite records.

Confirmation rechecks the source and checkout, creates an in-progress ticket,
commits pending work with normal Git hooks, and admits a completed Build on the
existing environment. The normal pipeline tab becomes active. The graph's first
Build attempt retains the original transcript and immutable generated notes;
its inspector also shows the reviewed acceptance criteria. The usual Review,
Address, Verify, delivery, conflict resolution and Notes lifecycle follows.
Restarting Build creates an ordinary ticket-based session and retains the
original as the first attempt. Pipeline records and ticket linkage provide the
same sidebar, coordinator and PR ownership as any other pipeline.

The created ticket has no delivery choice of its own, so it follows the default
("Open a PR, don't merge"). Changing the ticket's **When verified** choice before
Verify passes applies to this run, as for any ticket build. After adoption the
run starts at package preparation: with one reviewer a Package Preparation
Session plans validation, the backend runs it, a read-only Review Session reads
the sealed package, and Verify decides delivery.

`mise run test:agent:auto-pipeline` qualifies this whole path in a real browser
against a disposable profile whose only agent is Pi on a loopback fake model
([agent-testing.md](../development/agent-testing.md#auto-pipeline-flow-fake-model)):
drafting, title and criterion edits, confirmation, the promotion commit, the
adopted Build, commit-only delivery finishing while another environment is
shown, and the finished graph after a reload.
