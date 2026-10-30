# Coordinator worker surfaces: follow-ups

Checked against `main` at `863b5782` (2026-10-27).

The worker surfaces built for
[0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
(terminal, browser, tab edits, reviewer tabs, custom fix, feature plans,
the root-changes request) act on this node only, and feature plans never
wake the coordinator. (A looped review surface was also built; it was removed
with the Looped Review feature.) This file holds the work those decisions
left.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

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

### Tasks

1. **Worker surfaces on other nodes**: `nodeId` on `launch_terminal`, `open_worker_browser`, `edit_worker_tab`, `custom_fix_multi_review` and `open_multi_review` with `reviewerId`. Status: done.
2. **Root changes into a worker on another node**: `request_root_changes` with `nodeId`, which needs the patch to cross the node link. Status: open (scope call for the user).
3. **Status wakes for feature plans**: an association kind, listed by `list_workflows`, with status-wake rules. Status: open (scope call for the user).
4. **Live `surfaces` scenario**: a scenario in `mise run test:agent:coordinator` that calls each tool once on a real stack. Status: open (needs a live provider).
5. **Adopting feature plans (open question)**: whether `adopt_workflow` should accept them. Status: open (depends on 3).

### 1. Worker surfaces on other nodes

**Problem.** A coordinator on a command node can launch, message and review
workers on its leaf nodes, but cannot open a terminal or browser in them, edit
their tabs, run a custom fix or open a reviewer's tab.

**Context.** Every surface command is on `NODE_EXCLUDED_COMMANDS`
(`apps/backend/src/core/nodes/node-routing.ts:71-84`), so none crosses a node
link. The coordinator reaches a leaf through dedicated controller commands
instead: `launch_coordinator_node_multi_review`
(`apps/backend/src/core/commands-registry-coordinator-nodes.ts:604`),
`coordinator_node_multi_review_surface` (`:748`, surfaces `root`, `fix` and
`address` only, `:751-752`) and, since #1394, `create_coordinator_pr`, which
calls `create_controller_pr` on the leaf through `remote.call` inside
`withCoordinatorReceipt`
(`apps/backend/src/core/coordinator-surface-actions.ts:438-470`). The leaf
controller commands are workspace-excluded
(`node-routing.ts:123-130`), so only a command node's coordinator can call
them.

**Investigation.** Four tools take no `nodeId`:
`launch_terminal`, `open_worker_browser` and `edit_worker_tab` in
`apps/backend/src/core/control-mcp-coordinator-surfaces.ts`;
`custom_fix_multi_review` in
`apps/backend/src/core/control-mcp-review-actions.ts:289-319`.
`open_multi_review` does take `nodeId`, but refuses it together with
`reviewerId` (`control-mcp-review-actions.ts:261-262`: "Reviewer tabs open on
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
    - Cons: the local commands check coordinator scope against this node's store, which the leaf does not have; it would re-open the commands `NODE_EXCLUDED_COMMANDS` keeps closed.
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
(`control-mcp-coordinator-surfaces.ts:156-185`). The changes live in the
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

**Open for the user.** This is a scope call between the first and third
options, so it was left open on 2026-10-30.

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
(`control-mcp-coordinator-surfaces.ts`), which tells the coordinator to
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

### 4. Live `surfaces` scenario

**Problem.** The tools have unit and component evidence only.

**Context.** The live suite's scenarios are `read-only`, `async`, `family`,
`status` and `peer` (`apps/desktop/scripts/dev/coordinator-live.ts:56-62`);
the spec is `e2e/agent-testing/coordinator-live.spec.ts`. 0142's own live runs
cover the same tools on this node.

**Investigation.** No `surfaces` scenario exists. The root-changes approval
needs a person or the spec to approve the node action request.

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

### 5. Adopting feature plans (open question)

**Problem.** If the conversation that started a feature plan
closes, nothing else can receive its status.

**Context.** `adopt_workflow` takes an `associationId`
(`apps/backend/src/core/control-mcp-coordinator-tools.ts:170-191`), so only
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

## Current state

- The tools and their backend commands are described in
  [`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces).
- The backend surface commands are still on `NODE_EXCLUDED_COMMANDS`
  (`apps/backend/src/core/nodes/node-routing.ts`), so none of them crosses a
  node link itself. Since task 1, `launch_terminal`, `open_worker_browser`,
  `edit_worker_tab`, `create_pr`, `custom_fix_multi_review` and
  `open_multi_review` (with or without `reviewerId`) take `nodeId`. The
  command node keeps the receipt and calls the leaf's own controller
  commands (`launch_controller_terminal`, `open_controller_browser`,
  `edit_controller_worker_tab`, `create_controller_pr`, and the `reviewer`
  and `custom-fix` surfaces of `controller_multi_review_surface`), which are
  node-link only. `propose_agents_md_update` takes `nodeId` too.
- `request_root_changes` still acts on this node only (task 2).
- Feature plans have no `CoordinatorWorkflowAssociation` kind, so
  `list_workflows` does not list them and status wakes
  (`coordinator-status-wakes.ts`) never report them. Their tool results say
  so and point at `create_schedule`.

## Outstanding work

### Code

1. **Root changes on other nodes.** `request_root_changes` across nodes needs
   the patch to travel from this node's checkout to a leaf worker, or a clear
   refusal. Waiting on the user's scope call; see task 2.
2. **Status wakes for feature plans.** An association kind, listed by
   `list_workflows`, and status-wake rules (planning reply ready, failed)
   with the same ownership, budget
   and restart guarantees as Multi Review. See task 3.

### Qualification

3. **Live coordinator suite scenario.** A `surfaces` scenario in
   `mise run test:agent:coordinator` that calls each tool once and checks the
   resulting tabs and the root-changes approval on a real stack. See task 4.
   The remote variants from task 1 have component evidence only
   (`coordinator-surfaces-remote.test.ts`, simulated node link); a
   two-node live check is still owed.

## Constraints and rationale

- The read-only boundary does not move: nothing here may write to the
  project checkout, and the root-changes patch still needs the user's
  approval.

## Open questions

- Should a feature plan started by the coordinator be
  adoptable like other workflows (`adopt_workflow`)? See task 5.

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

An older leaf answers an unknown controller command with
`Unknown command: …`, which `coordinatorNodeTarget` already turns into
"update it, then retry". An older `controller_multi_review_surface` answers
the new surfaces with "Expected surface root, fix or address.", and the
command node maps that text to the same message.

### Tasks 2 and 3: left open for the user (2026-10-30)

The brief made both of them scope calls for the user. Each subsection ends
with **Open for the user**, setting out the trade-off. Neither has any code
on this branch.

### Tasks 4 and 5: not started (2026-10-30)

Task 4 needs real provider turns, which this work was not allowed to run.
Task 5 depends on task 3.

## Related

- [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
  for the live suite.

## Replaces

- Nothing.
