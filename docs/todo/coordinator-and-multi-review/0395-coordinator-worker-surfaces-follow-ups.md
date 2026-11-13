# Coordinator worker surfaces: follow-ups

Checked against `main` at `863b5782` (2026-10-27).

The worker surfaces built for to-do 0142 (retired 2026-11-11; see
[`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces))
(terminal, browser, tab edits, reviewer tabs, custom fix, feature plans,
the root-changes request) acted on this node only, and feature plans did not
wake the coordinator (task 3 since added that). (A looped review surface was also built; it was removed
with the Looped Review feature.) This file holds the work those decisions
left.

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`: tasks 1 and 3 are on
`main`, task 2 still waits on the user's scope call, and tasks 4 and 5 are done
on branch `launch-override-marker-043a84998c41-r1` (task 4's billed Claude run
is on the manual-test checklist). Earlier analyses follow.

First analysed 2026-10-28 against `main` at `79f3bc97`.

Merge reconciliation against `main` at `f8caffa71` (2026-10-29): Looped Review
was removed, so tasks 1, 3 and 5 below now cover the surviving surfaces and
feature plans only. The remaining tasks are open. Since this file was written, `create_pr` (#1394,
`153de25b`) and `propose_agents_md_update` (#1355, `536394f7`) gained
`nodeId`; neither was on this file's list, but `create_pr`'s relay is now the
nearest template for task 1.

Rechecked 2026-10-30 against `main` at `cd7bbe3e5`: none of tasks 1–5 had
merged. Task 1 is done on branch
`todo-0395-coordinator-worker-surfaces-1f17c5be4010`. Tasks 2 and 3 stay open
as scope calls for the user; each subsection now ends with **Open for the
user**, setting out the trade-off. Composable graphs (#1436, `3fa7d1733`) added
a fourth association kind, `graph-run`, which task 3's context now cites.

Rechecked 2026-11-03 against `main` at `7b48c23fb`: task 3 is done on branch
`coordinator-feature-plan-a803a78f59d7-r1`, which adds a `feature-plan`
association kind.

### Tasks

1. **Worker surfaces on other nodes**: `nodeId` on `launch_terminal`, `open_worker_browser`, `edit_worker_tab`, `custom_fix_multi_review` and `open_multi_review` with `reviewerId`. Status: done.
2. **Root changes into a worker on another node**: `request_root_changes` with `nodeId`: build whichever option the scope call picks (a patch sent to a leaf controller command, or a clear refusal across nodes). Status: blocked (waits on 7568: 0395 task 2 scope call).
3. **Status wakes for feature plans**: an association kind, listed by `list_workflows`, with status-wake rules. Status: done.
4. **Live `surfaces` scenario**: add a scenario to `mise run test:agent:coordinator` that calls each tool once on a real stack. The billed run of it is on the manual-test checklist (7568). Status: done (the scenario; its billed run is 7568's).
5. **Adopting feature plans (open question)**: whether `adopt_workflow` should accept them. Status: done (yes, as recommended; proved by test).

### 1. Worker surfaces on other nodes

**Problem.** A coordinator on a command node can launch, message and review
workers on its leaf nodes, but cannot open a terminal or browser in them, edit
their tabs, run a custom fix or open a reviewer's tab.

**Context.** Every surface command is on `NODE_ROUTING_EXCLUDED_COMMANDS`
(`apps/backend/src/core/nodes/node-routing.ts`; called `NODE_EXCLUDED_COMMANDS`
until 2026-11-07, when plan item
[7012](../../../plans/unified/7012-allow-listed-grants.md) renamed it), so none
crosses a node link. The coordinator reaches a leaf through dedicated controller commands
instead: `launch_coordinator_node_multi_review`
(`apps/backend/src/core/commands-registry-coordinator-nodes.ts:604`),
`coordinator_node_multi_review_surface` (`:748`, surfaces `root`, `fix` and
`address` only, `:751-752`) and, since #1394, `create_coordinator_pr`, which
calls `create_controller_pr` on the leaf through `remote.call` inside
`withCoordinatorReceipt`
(`apps/backend/src/core/coordinator-surface-actions.ts:438-470`). The leaf
controller commands are defined with `access: "internal"`, which no workspace
grant or relayed call admits (the grant allow-list replaced the old
workspace exclusions on 2026-11-07,
[7012](../../../plans/unified/7012-allow-listed-grants.md)), so only a command
node's coordinator can call them.

**Investigation.** Four tools take no `nodeId`:
`launch_terminal`, `open_worker_browser` and `edit_worker_tab` in
`apps/backend/src/core/control-mcp/coordinator-surfaces.ts`;
`custom_fix_multi_review` in
`apps/backend/src/core/control-mcp/review-actions.ts:289-319`.
`open_multi_review` does take `nodeId`, but refuses it together with
`reviewerId` (`control-mcp/review-actions.ts:261-262`: "Reviewer tabs open on
this node only"). `create_pr` shows the shape a remote surface needs: the
command node validates the worker on the leaf (`remote.environment`), admits
its own receipt, and derives the leaf's request ID from the receipt key, so a
retry with the same `requestId` replays on the leaf rather than acting twice.
The node link records a write whose answer was lost as outcome-unknown and
never resubmits it (`node-routing.ts:17-18`, `NodeOutcomeUnknownError` in
`nodes/node-link.ts`).

**Decisions.**

- **How should each surface reach the leaf?**
  - **One controller command per surface on the leaf, called like `create_controller_pr` (recommended).** Add `launch_controller_terminal`, `open_controller_browser`, `edit_controller_worker_tab`, each workspace-excluded; extend `coordinator_node_multi_review_surface` with `reviewer` and `custom-fix` surfaces for the two Multi Review tools.
    - Pros: each command checks its own scope on the leaf; reuses the receipt and request-ID derivation `create_pr` already proves; the two Multi Review surfaces fit the existing relay.
    - Cons: three new leaf commands to keep in step with the local ones; an older leaf refuses them, so the tool must report "update that node".
  - **A generic relay that forwards the local surface command to the leaf.**
    - Pros: one code path for every surface.
    - Cons: the local commands check coordinator scope against this node's store, which the leaf does not have; it would re-open the commands `NODE_ROUTING_EXCLUDED_COMMANDS` keeps closed.
- **What happens when the leaf's answer is lost?**
  - **Return outcome-unknown and let the coordinator retry with the same `requestId` (recommended).** The leaf request ID derives from the receipt key, so the retry replays the leaf's receipt. `edit_worker_tab` has no receipt but states an end state, so a retry is a no-op there too.
    - Pros: matches the node-link rule (never resubmit automatically) and `create_pr`.
    - Cons: the coordinator must be told to retry; the result text has to say so.
  - **Resubmit automatically once.**
    - Pros: fewer coordinator turns.
    - Cons: breaks the node-link rule; a terminal launch without a leaf receipt could run its command twice.

**Status.** Done with both recommended options; see
[Assumptions and decisions](#assumptions-and-decisions) and
[`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces).

### 2. Root changes into a worker on another node

**Problem.** `request_root_changes` copies uncommitted checkout changes into a
local worker only. A worker on a leaf cannot receive them.

**Context.** The patch is built from this node's checkout against a scratch
index and object store, then applied in the worker with `git apply --check`
and `git apply` (`apply_project_root_changes`, described in
[`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces)).
`apply_project_root_changes` is node-excluded (`node-routing.ts:84`), and only
the user's approval of the `apply-root-changes` node action request runs it.

**Investigation.** The tool takes no `nodeId`
(`control-mcp/coordinator-surfaces.ts:156-185`). The changes live in the
command node's checkout, so the leaf's own copy of the project does not have
them: using the leaf's checkout as the source (the alternative the file named)
would copy whatever is uncommitted there, which is not what the user asked
for.

**Decisions.**

- **Where does the patch come from, and how does it travel?**
  - **Build it on the command node after approval and send it to a leaf controller command that applies it in the worker (recommended).** The approval stays on the command node; the leaf runs only `git apply --check` and `git apply`, whole or not at all.
    - Pros: the user's changes are the ones applied; the checkout stays untouched; the approval flow does not change.
    - Cons: needs a size bound on the patch over the node link (binary files can be large) and a new leaf command that accepts a patch.
  - **Use the leaf's own checkout as the source.**
    - Pros: no patch crosses the link.
    - Cons: applies the wrong changes (the leaf's, not the user's) unless the user works on the leaf.
  - **Refuse across nodes and tell the coordinator to have the user commit and push.**
    - Pros: no new code; a pushed branch already reaches a remote worker.
    - Cons: the user loses the feature exactly where workers usually run.

**Waiting on the scope call.** The choice between the first and third
options is the user's; it moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md) on
2026-11-10. What each option would take:

- *A new leaf command that applies a patch sent over the node link.* The user
  keeps the feature for remote workers, and the approval dialog and read-only
  checkout stay as they are. The cost is new surface on both sides. One part
  is a leaf command (for example `apply_controller_root_patch`) that only a
  command node can call and that runs `git apply --check` and `git apply`
  whole or not at all. The other is a size bound for the patch: the node link
  carries at most 64 MiB per answer (`MAX_INVOKE_RESPONSE_BYTES`,
  `nodes/node-link.ts:50`) and node file writes go in 4 MiB chunks
  (`NODE_FILE_CHUNK_BYTES`, `nodes/node-files.ts:21`), so a large binary
  patch needs either a cap or chunked transfer. The dialog would also need
  to say which node the worker is on, and an older leaf would have to refuse
  with "update that node".
- *Refuse across nodes and ask the user to commit and push.* Nothing new to
  build or keep in step, and a pushed branch already reaches any worker. But
  the feature stops working on remote workers, which are where workers
  usually run once a command node exists, and the user has to commit work
  they meant to keep uncommitted.

If the user picks the first option, the recommended option above holds. If
they pick the second, the change is a clear refusal in
`request_coordinator_root_changes` whenever `nodeId` names another node,
plus a sentence in the tool description.

### 3. Status wakes for feature plans

**Problem.** A coordinator that starts a feature plan is never told when it
finishes. `list_workflows` does not show it.

**Context.** `CoordinatorWorkflowAssociation.kind` is
`"environment" | "build-pipeline" | "multi-review" | "graph-run"`
(`packages/protocol/src/coordinator.ts:287`; `graph-run` came with #1436).
Status wakes react to `multi-review`, `build-pipeline` and `graph-run`
resource changes (`apps/backend/src/core/coordinator-status-wakes.ts:863`).

**Investigation.** The feature-plan tool returns `NO_STATUS_WAKE`
(`control-mcp/coordinator-surfaces.ts`), which tells the coordinator to
schedule a check with `create_schedule`. Its receipts are stored
(`coordinator-surface-actions.ts`), but no association is written.

**Decisions.**

- **How should the workflows be associated?**
  - **A new association kind, `feature-plan` (recommended).**
    - Pros: `list_workflows`, status wakes and adoption all key on the kind; ownership, budget and restart handling come with it.
    - Cons: an older backend sharing the data directory may not expect the new kind; its coordinator store reader must skip or keep unknown kinds rather than fail.
  - **Reuse `multi-review` with a subtype field.**
    - Pros: no new kind for old readers.
    - Cons: every Multi Review rule would have to branch on the subtype; a feature plan has no reviewers or consolidation.
- **Which states wake?**
  - **Planning reply ready and failed (recommended).**
    - Pros: the settled states the file names; one wake per settled state, deduplicated by `CoordinatorStatusNoticeRecord.key`.
    - Cons: progress stays quiet until the plan settles.
  - **Every feature-plan progress update.**
    - Pros: progress is visible.
    - Cons: many wakes for one task; goes against "nothing mid-turn wakes the coordinator".

**Open for the user.** A new association kind is a data-directory
compatibility call, so it was left open on 2026-10-30.

- *A new `feature-plan` kind.* `list_workflows`, status wakes and adoption
  would all work as they do for other kinds. On the compatibility side, the
  coordinator store reader keeps an association of any kind: it checks only
  `id`, `projectId` and `coordinatorId`
  (`apps/backend/src/core/storage-coordinators.ts:103-113`). So an older
  backend sharing the data directory keeps the record and writes it back.
  `graph-run` (#1436) already relies on this. What has not been checked is
  how each older code path handles a kind it does not know, for example
  `list_workflows` summaries and the maintenance sweep. Receipts are
  stricter: the reader drops a receipt whose `action` it does not know
  (`isActionReceipt`, `storage-coordinators.ts:921-933`), and its next save
  loses it. So the feature-plan work must not add a new receipt action, or
  it must accept that an older backend drops it.
- *Reuse `multi-review` with a subtype.* An older backend already knows the
  kind, but it would apply Multi Review rules (fetching the review,
  consolidation and fix wakes) to a feature plan, which is worse than
  ignoring it. Every current Multi Review rule would also need a subtype
  branch.

Running backends of two versions on one data directory is the case to decide
for. If the user accepts that an older backend may list or sweep a
`feature-plan` association it does not understand, the recommended option
holds. Task 5 follows from whatever is chosen here.

**Status.** Done on 2026-11-03 against `main` at `7b48c23fb`, with both
recommended options (the ticket settled the scope call: a `feature-plan` kind,
waking on reply ready and failed, with older readers skipping unknown kinds).
See [Assumptions and decisions](#assumptions-and-decisions) and
[`coordinator.md`, "Status wakes"](../../architecture/coordinator.md#status-wakes).
Adoption (task 5) already works on the new kind: `adopt_workflow` accepts any
association, and re-opening it re-sends the reply notice to the adopter.

### 4. Live `surfaces` scenario

**Problem.** The tools have unit and component evidence only.

**Context.** The live suite's scenarios are `read-only`, `async`, `family`,
`status` and `peer` (`apps/desktop/scripts/dev/coordinator-live.ts:56-62`);
the spec is `e2e/agent-testing/coordinator-live.spec.ts`. The billed run of
the same tools on this node, carried from to-do 0142 (retired), is on the
manual-test checklist. On a loopback fake model,
`mise run test:agent:coordinator:surfaces-fake` (passed 2026-11-11) already
drives `request_root_changes` through the approval dialog and
`open_worker_browser` on a container worker
([agent-testing.md](../../development/agent-testing.md#coordinator-worker-surfaces-fake-model)).

**Investigation.** No `surfaces` scenario existed. The root-changes approval
needs a person or the spec to approve the node action request. The spec runs
in the profile's browser client, where the root-changes dialog
(`RootChangesApprovalDialog`, test id `root-changes-request`) opens for any
pending `apply-root-changes` request with the coordinator's files
pre-selected, so the spec can click **Apply** as the user does, as
`coordinator-surfaces-fake.spec.ts` already does on a fake model.

**Decisions.**

- **What counts as a pass?**
  - **One Claude run on this node: each tool returns without error, the tabs it opens appear in `list_tabs`, the root-changes approval is accepted through the approval dialog and the chosen files land in the worker, and the project checkout's `git status` is unchanged (recommended).**
    - Pros: covers every tool and the read-only boundary in one run; the tools are Control MCP calls, so the provider matters little.
    - Cons: does not cover other providers' tool calling or the remote case (tasks 1 and 2).
  - **Every platform in the suite.**
    - Pros: matches the other scenarios.
    - Cons: costs one real run per platform for tools that do not depend on the provider.
- **How does the spec approve the request?**
  - **Click the approval dialog in the profile's UI (recommended).**
    - Pros: tests what the user sees.
    - Cons: a slower and more brittle step.
  - **Resolve the node action request with a direct command.**
    - Pros: quick and stable.
    - Cons: skips the dialog, which is the part the user relies on.

**Status.** Done on 2026-11-11 with both recommended options; see
[Assumptions and decisions](#assumptions-and-decisions) and
[`agent-testing.md`, "Live coordinator suite"](../../development/agent-testing.md#live-coordinator-suite).
The billed Claude run is on the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md).

### 5. Adopting feature plans (open question)

**Problem.** If the conversation that started a feature plan
closes, nothing else can receive its status.

**Context.** `adopt_workflow` takes an `associationId`
(`apps/backend/src/core/control-mcp/coordinator-tools.ts:170-191`), so only
associated workflows can be adopted.

**Investigation.** Without task 3 there is nothing to adopt. With it, adoption
works on the new kind unless it is filtered out.

**Decisions.**

- **Should they be adoptable?**
  - **Yes, as soon as task 3 gives them associations (recommended).**
    - Pros: same rule as every other coordinator workflow; no special case.
    - Cons: a second conversation can take over a feature plan it did not start (as it can for a Multi Review today).
  - **No.**
    - Pros: none beyond less to test.
    - Cons: a closed conversation's feature plan never reports again.

**Status.** Done on 2026-11-11 with the recommended option. `adopt_workflow`
already accepted any association kind, so no code changed; two tests in
`coordinator-status-wakes-feature-plan.test.ts` ("adopting a feature plan")
now prove it through the `adopt_coordinator_workflow` command the tool calls.

## Current state

- The tools and their backend commands are described in
  [`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces).
- The backend surface commands are still on `NODE_ROUTING_EXCLUDED_COMMANDS`
  (`apps/backend/src/core/nodes/node-routing.ts`, the `invoke_on_node`
  exclusions, named `NODE_EXCLUDED_COMMANDS` before 2026-11-07), so none of
  them crosses a node link itself. Since task 1, `launch_terminal`, `open_worker_browser`,
  `edit_worker_tab`, `create_pr`, `custom_fix_multi_review` and
  `open_multi_review` (with or without `reviewerId`) take `nodeId`. The
  command node keeps the receipt and calls the leaf's own controller
  commands (`launch_controller_terminal`, `open_controller_browser`,
  `edit_controller_worker_tab`, `create_controller_pr`, and the `reviewer`
  and `custom-fix` surfaces of `controller_multi_review_surface`), which are
  node-link only. `propose_agents_md_update` takes `nodeId` too.
- `request_root_changes` still acts on this node only (task 2).
- Since task 3, each `launch_feature_plan` message writes a `feature-plan`
  association naming its planning exchange (`featurePlan.operationId`),
  before planning starts. Status wakes report its reply ready and each
  failure (`coordinator-feature-plan-status.ts`), and `list_workflows` lists
  it with the plan. Another conversation can adopt it (task 5).
- Since task 4, `mise run test:agent:coordinator --scenario surfaces` runs
  each local worker-surface tool on a real stack (Claude only); it has not
  had its billed run yet.

## Outstanding work

### Code

1. **Root changes on other nodes.** `request_root_changes` across nodes needs
   the patch to travel from this node's checkout to a leaf worker, or a clear
   refusal. Waiting on the scope call on the manual-test checklist; see task 2.

### Qualification

2. **Billed run of the `surfaces` scenario.** Built (task 4); its billed
   Claude run is on the manual-test checklist. The remote variants from task 1
   have component evidence only (`coordinator-surfaces-remote.test.ts`,
   simulated node link); the checklist's 0142 item covers the tools on real
   providers.

## Constraints and rationale

- The read-only boundary does not move: nothing here may write to the
  project checkout, and the root-changes patch still needs the user's
  approval.

## Assumptions and decisions

### Task 1: one leaf controller command per surface (2026-10-30)

I took the recommended option. `launch_controller_terminal`,
`open_controller_browser` and `edit_controller_worker_tab` are new commands
in `commands-registry-controller-workflows.ts`. `controller_multi_review_surface`
gained `reviewer` and `custom-fix` surfaces, and
`coordinator_node_multi_review_surface` relays them. The leaf commands are on
the workspace-excluded list, like `create_controller_pr`, so only an attached
command node can call them. The command node keeps the receipt and the
coordinator scope check. The leaf checks the project and refuses its
checkout. The current code agreed with the analysis, so nothing in the
recommendation needed correcting.

To keep the local and leaf paths from drifting apart (the option's main con),
the terminal, browser and tab-edit bodies moved out of
`coordinator-surface-actions.ts` into `worker-surface-runs.ts`. The local
`*_coordinator_*` commands and the leaf commands now call the same code. The
local receipts' payload hashes are unchanged, so receipts written before this
change still replay.

### Task 1: a lost answer returns outcome-unknown with a retry instruction (2026-10-30)

I took the recommended option. When the leaf's answer is lost, the tool
result gives the node link's outcome-unknown text, and `withRetryAdvice`
(in `commands-registry-coordinator-nodes.ts`) adds what to do next: retry
with the same `requestId`, or, for `edit_worker_tab`, repeat the same edit.
The failed run releases its receipt, so the retry runs again. It reattaches
on the leaf because every leaf ID derives from the receipt key: the terminal
job's request ID (`controller:<key>`), the browser tab and navigation IDs,
and the node-link request keys. `create_pr`'s relay gets the same advice
text.

### Task 1: a custom-fix retry after its handoff is reported, not refused (2026-10-30)

`MultiReviewService.customFix` replays only while its handoff is still
pending. Once the fix has been delivered, the review is no longer `ready`, so
the same request again would be refused, even though the first attempt
succeeded. The leaf's `custom-fix` surface therefore checks the review first.
If the review is past `ready`, its handoff is no longer pending and its
`fixLaunch` is the same custom instruction (and model, when one was given),
the leaf reports that fix and opens its Fix tab instead of starting another.
The leaf has no coordinator receipt store to tell a retry from a new request.
So a different `requestId` with the same instruction, sent while that fix
runs, is also reported rather than refused. No second fix starts either way.

### Task 1: the command node checks its own delegations before a remote close (2026-10-30)

A delegation to a remote worker lives on the command node
(`CoordinatorWorkflowAssociation.nodeId`), so the leaf cannot see it.
`edit_coordinator_worker_tab` refuses a remote close itself while this
conversation's command node has an open delegation on that tab. The leaf
still refuses busy native tabs and its own local delegations. Remote
delegations take no close-admission lock on the command node
(`storage-coordinators.ts`, `openCoordinatorDelegation`), so this check is
best effort against a delegation opened at the same moment. Local closes keep
the lock.

### Task 1: an older leaf is told to update (2026-10-30)

An older leaf answers an unknown controller command, and `coordinatorNodeTarget`
turns that into "update it, then retry". (Corrected 2026-11-01: this said the
answer was `Unknown command: …`, but a real leaf answers
`Unknown backend command: …`, so the check never matched one until todo 1030
(retired) task 4.) An older `controller_multi_review_surface` answers
the new surfaces with "Expected surface root, fix or address.", and the
command node maps that text to the same message.

### Task 3: a `feature-plan` kind per message, waking on ready and failed (2026-11-03)

The ticket for task 3 made the scope call: a new association kind, waking on
the planning reply ready and on failure, with older readers skipping unknown
kinds. I took the recommended options. Choices it left to me:

- **One association per message, not per plan.** The association names the
  planning exchange (`featurePlan.operationId`, the
  `planning-coordinator-<key>` id the launch already derived). A plan takes
  messages from the user too, so a per-plan record could not tell the
  coordinator's reply from the user's. Its request ID is
  `feature-plan:<requestId>`, so it cannot collide with another launch's
  association under the same `requestId`, and a retry finds the same record.
- **Task 3 review repair: reserve before planning starts (2026-11-03).**
  Inside the receipt, after the plan exists and before `start_feature_planning`,
  reserve a pending association so a full store refuses before a turn begins.
  Activate after startup succeeds or the existing exchange is found; a
  confirmed refusal before attachment releases the reservation. Reconciliation
  ignores missing-operation evidence while pending and activates an attached
  exchange after a crash. This retains admission before acting without
  prematurely ending a follow. Writing an active association immediately
  would be simpler but loses wakes during startup or a same-request retry;
  writing it only after startup could refuse after work already began.
- **Ready is found on the plan.** A successful exchange detaches its planning
  record, so ready means an applied assistant message after the exchange's
  own user message (id = operation id) and before the next user message. A
  reply still pending or superseded does not count.
- **Failed is not terminal.** The user can retry a failed exchange from the
  Features board; the failure key includes when it occurred, so a retry's
  failure or reply is reported too. Ready is terminal.
- **Cancelled and deleted end quietly.** The ticket names ready and failed
  only; the user did the cancel. The association is marked notified without a
  wake.
- **Content-free notices.** Like graph runs: title, status, story count and
  the failure message, never the reply. The coordinator reads it with
  `get_feature_plan`.
- **Both statuses are sent whatever the wake setting.** They are the
  exchange's terminal phases (`isTerminalFeaturePlanningPhase`), and `off`
  keeps terminal workflow notices.
- **Older readers.** The store reader already kept unknown kinds; I checked
  the other paths. An older backend's status wakes filter by known kinds, its
  `list_workflows` gives an unknown kind a null resource, and its cleanup
  keeps a record with no notice and unknown state. This backend now does the
  same explicitly: `observeAssociation` skips an unknown kind instead of
  falling through to the Multi Review path. No receipt action was added (the
  receipt reader drops unknown actions). Retention reads a feature plan's
  state: active while its exchange is attached and not failed.
- **Notice resource.** `AGENT_MAIL_NOTICE_RESOURCES` gained `feature-plan`.
  An older reader's `normalizeAgentMailNotice` drops the structured notice
  but keeps the message, so the coordinator still reads the body.

### Tasks 2 and 3: left open for the user (2026-10-30)

The brief made both of them scope calls for the user. Each subsection ends
with **Open for the user**, setting out the trade-off. Neither has any code
on this branch.

### Tasks 4 and 5: not started (2026-10-30)

Task 4 needs real provider turns, which this work was not allowed to run.
Task 5 depends on task 3. (Both done since; see below.)

### Task 4: a Claude-only `surfaces` scenario, approved in the dialog (2026-11-11)

I took both recommended options: one Claude run on this node, and the spec
clicks **Apply** in the root-changes dialog. Choices the file left to me:

- **The harness makes the worker.** It creates an ordinary local environment
  with no agent, so the scenario costs one coordinator turn and its wake, not
  a worker turn too. Acting on a worker the coordinator did not launch needs
  the project's `coordinatorOtherEnvironments` opt-in, which the run sets and
  restores. The harness also writes one untracked file into the checkout for
  the request to copy, and removes it last.
- **One turn calls every tool in order:** `launch_terminal` (a plain tab
  running one `echo`), `open_worker_browser` (a loopback address nothing
  serves; the tab opens anyway), `list_tabs`, `edit_worker_tab` to focus the
  terminal and again to close the browser tab, then `request_root_changes`
  naming the file. `move` is left out because a fresh worker has one pane.
- **Left out:** `open_multi_review` with `reviewerId`, `custom_fix_multi_review`
  and the feature-plan tools. They need a finished review panel or a planning
  agent's own billed turns, and the checklist's 0142 item already runs them on
  real providers.
- **What passes:** every call made and without an error result; `list_tabs`
  shows both new tabs; the terminal tab's output (`get_terminal_output_snapshot`,
  read for up to 30 seconds after the turn) shows the run's `surfaces-<token>`
  marker as a whole printed line, so a tab that opens without running its
  command fails (added after Multi Review round 1); afterwards the layout keeps the terminal tab selected
  and holds no coordinator browser tab; the request reaches `executed` after
  the dialog's Apply; the file is in the worker byte for byte; the checkout's
  digest (files and Git state) is unchanged; one system message and exactly
  one coordinator turn follow the approval, watched for 30 more seconds; no
  interaction escaped the coordinator policy.
- **Claude only.** `surfacesApplies` skips every other platform with the
  reason, as `goal` and `deliver-now` do, so the default all-platform run
  costs no extra billed turns.
- **Budget:** four step budgets (the turn, the wait for the request, and two
  for the outcome and its wake).

The prompts and verdict are in `coordinator-live-surfaces.ts`, the
orchestration in `coordinator-live-surfaces-orchestration.ts`; both have
credential-free tests, the second over a scripted command transport. No
provider turn was run for this work.

### Task 5: feature plans are adoptable, with no code change (2026-11-11)

I took the recommended option. Adoption
(`adoptCoordinatorWorkflowAssociation`) checks that the adopting conversation
is open, that the association exists and that its current conversation is
closed, never its kind, and
status wakes route by the association's current conversation, so a feature
plan was already adoptable. The new tests cover both orders: a reply that
lands after adoption wakes only the adopter, and adopting after the reply was
reported re-sends it to the adopter.

## Related

- To-do 0142 (retired 2026-11-11; see [`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces)).
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
  for the live suite.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the scope call of task 2, the billed Claude run of task 4) moved there on 2026-11-10.

## Replaces

- Nothing.
