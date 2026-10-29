# Coordinator product surfaces

Checked against `main` at `863b5782` (2026-10-27).

## Task analysis (historical)

This analysis predates the implementation recorded below. All five surfaces
are now built; the current state, decisions and remaining qualification below
supersede the deferred statuses and proposed choices in this snapshot.

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Uncommitted root changes in a worker**: let the user hand a chosen patch of the root checkout's uncommitted changes to a new worker. Status: deferred.
2. **Terminal or tmux launch**: a coordinator tool that opens a terminal, tmux or terminal-agent tab in a worker. Status: deferred.
3. **Browser launch and navigation**: a coordinator tool that opens or drives a worker's preview. Status: deferred.
4. **Pane editing**: a coordinator tool that opens, closes or moves a worker's tabs. Status: deferred.
5. **Multi Review and planning launches**: custom-fix model switches, reviewer subtabs, looped review and feature-plan launch. Status: deferred (choosing a fix model at launch already exists).
6. **Prioritise or retire the file**: the open question of which surface comes first, given no user request. Status: open.

### 1. Uncommitted root changes in a worker

**Problem.** A coordinator worker starts from a commit, so work the user has not committed in the root checkout cannot be continued in a worker without the user committing it first.

**Context.** The file wants the user, not the coordinator, to pick the files, because a coordinator is read-only on the checkout (`coordinator.md`) and repository checkout mutation stays UI-only (Constraints).

**Investigation.** Still accurate, and the surface is slightly richer than the file says. `get_launch_options` returns both `coordinatorBase` and `checkoutBase` (`apps/backend/src/core/control-mcp-tools.ts:660-719`); the `checkoutBase` description says "Uncommitted changes are never included" (`control-mcp-tools.ts:231`), and a launch from the checkout's own HEAD reports `liveCheckoutHasUncommittedChanges` (`control-mcp-tools.ts:1368-1467`). So the coordinator can already tell the user that a worker will miss uncommitted work; nothing can carry it across. No patch-transfer command exists. `transfer_files` is in the tool list (`packages/protocol/src/coordinator.ts:327`) but moves files between environments, not a root diff.

**Decisions.**

- **Who initiates the transfer?**
  - **A UI action on the worker launch, offered when `liveCheckoutHasUncommittedChanges` is true (recommended).** The user ticks files in a dialog; the coordinator never sees the content.
    - Pros: keeps checkout reads and the choice of files with the user; reuses an existing signal; no new coordinator authority.
    - Cons: the coordinator cannot complete the flow on its own; needs a new dialog and a pending-launch state.
  - **A coordinator tool that asks the user to approve a named file list.** Like `request_project_file_update`, a request the user confirms.
    - Pros: fits the coordinator's request-and-confirm pattern; works from chat.
    - Cons: the coordinator chooses which paths to propose, which needs it to read the dirty file list; a new credential scope and idempotency record.
- **Patch or file copy?**
  - **A `git diff` patch applied with `git apply --3way` on the worker's base (recommended).**
    - Pros: carries deletions and renames; fails visibly on conflict; the worker's history stays clean.
    - Cons: binary and untracked files need separate handling; a patch against a base that moved can conflict.
  - **Copy whole files.**
    - Pros: simple; handles untracked and binary files.
    - Cons: silently overwrites base changes; loses deletions.

### 2. Terminal or tmux launch

**Problem.** A coordinator can start agent jobs (`launch_job`) but cannot open a plain terminal or a tmux/terminal-agent tab in a worker, so long-running shell work (a dev server, a watcher) has to go through an agent turn.

**Context.** The file points at the backend `launch_terminal_job` command and says each surface needs its own authority and idempotency design.

**Investigation.** Accurate. `launch_terminal_job` is at `apps/backend/src/core/commands-registry-terminal.ts:208`. It already takes a required `requestId` (at most 256 characters), a `tabType` of `plain`, `claude-tmux` or a terminal agent (not `cursor`), and up to 500,000 characters of input, and it refuses an environment that is not running and ready. Its only callers are agent sign-in (`commands-registry-accounts.ts:98`) and the launch-activity reconciler (`native-agent-launch-activity-reconciler.ts:1412`, `:1432`). It is not in `COORDINATOR_CONTROL_TOOL_NAMES` (`packages/protocol/src/coordinator.ts:327-384`). Separately, the public API already has an admitted, request-keyed `environment.exec` (`apps/backend/src/core/public-api/actions-exec.ts:164`) with run status, output and cancel, which is a closer fit for "run a command and read the result" than a terminal tab.

**Decisions.**

- **Which primitive to expose?**
  - **Expose `environment.exec` semantics (bounded command, status, output, cancel) as a coordinator tool (recommended).**
    - Pros: already follows the public-API admission rules (request key reserved before side effects, content-free receipts); the result is readable by the coordinator; no new tab to clean up.
    - Cons: not interactive; a dev server that must outlive the run needs a separate story.
  - **Expose `launch_terminal_job` as is.**
    - Pros: already exists with a `requestId`; gives the user a visible tab.
    - Cons: the coordinator cannot read the terminal back (terminal contents must not reach logs or receipts); it writes arbitrary input into a shell, a much wider authority than `launch_job`'s agent turn.
- **Which tier?**
  - **The same tier as `launch_job` (mutating, confirmable) (recommended).**
    - Pros: same blast radius as a build-mode agent; consistent user expectations.
    - Cons: still lets a coordinator run arbitrary commands in a worker without an agent's own approvals.
  - **A separate, off-by-default tier.**
    - Pros: users opt in explicitly.
    - Cons: one more setting; parity across platforms stays the same either way.

### 3. Browser launch and navigation

**Problem.** A coordinator cannot open or drive a worker's preview, so it cannot check a UI change it delegated.

**Context.** Listed as deferred in the file; needs authority design because a preview runs the worker's code.

**Investigation.** Still not exposed. The backend has the parts: `get_preview_services` (`apps/backend/src/core/commands-registry-previews.ts:53`), `resolve_preview_target` (`:91`) and `create_preview_handoff_url` (`:124`), plus `open_in_browser`. None is in the coordinator tool list, and `control-mcp-tools.ts` has no browser tool.

**Decisions.**

- **What should the first step do?**
  - **Read-only: list a worker's preview services and open one in the user's preview pane (recommended).**
    - Pros: reuses `get_preview_services` and the existing preview UI; no page content reaches the coordinator.
    - Cons: the coordinator still cannot verify the page itself.
  - **Full navigation and page reads for the coordinator.**
    - Pros: lets the coordinator check a change end to end.
    - Cons: page content, cookies and preview tokens become coordinator-visible; needs redaction rules and a much larger authority review.

### 4. Pane editing

**Problem.** A coordinator cannot arrange a worker's tabs (open, close, move), so the user tidies up after delegation by hand.

**Context.** Deferred; closing a tab must never delete a conversation (invariant 13).

**Investigation.** Not exposed. The backend stores pane layouts with optimistic concurrency: `save_pane_layout` takes `expectedRevision` (`apps/backend/src/core/commands-registry-sessions.ts:158`), with `get_pane_layout` and `delete_pane_layout` alongside. Coordinators can read tabs (`list_tabs`, `get_tab_state`) but not change the layout.

**Decisions.**

- **How should edits be expressed?**
  - **Named operations (focus, move, close) that the backend applies with the layout revision (recommended).**
    - Pros: replays cleanly under a `requestId`; the backend can refuse a close that would orphan work; reuses `expectedRevision`.
    - Cons: one more tool per operation.
  - **Hand the coordinator `save_pane_layout` with a whole layout.**
    - Pros: one tool; already exists.
    - Cons: a stale layout overwrites user changes; the coordinator must understand the layout schema.
- **Should close be included?**
  - **No, only focus and move at first (recommended).**
    - Pros: avoids any path near tab teardown and conversation retention.
    - Cons: the main tidying case (closing finished tabs) is not covered.
  - **Yes, through the normal retaining close.**
    - Pros: covers the real need.
    - Cons: needs the full close semantics (pending 503, last-owner rules) surfaced to the coordinator.

### 5. Multi Review and planning launches

**Problem.** Coordinators drive Multi Review but cannot switch the fix model after a review, open a reviewer's subtab, start a looped review or launch a feature plan.

**Context.** The file groups these four as "Multi Review and planning workflows".

**Investigation.** Partly out of date. `launch_multi_review` already accepts `reviewers`, `reviewModel` and `fixModel` (`apps/backend/src/core/control-mcp-review-actions.ts:150-175`, `fixModel` at `:169`), so a custom fix model can be chosen at launch. `address_multi_review`, `open_multi_review` and `open_multi_review_fix` take only `workflowId` (`control-mcp-review-actions.ts:210-258`), so there is no switch afterwards and no reviewer subtab. Looped review has a full backend command set (`start_looped_review` at `apps/backend/src/core/commands-registry-reviews.ts:189`, plus pause, resume, retry and cancel) and feature plans have `create_feature_plan`/`update_feature_plan` (`commands-registry-kanban.ts:129-132`), but neither has a coordinator tool.

**Decisions.**

- **Split this item?**
  - **Yes: record that launch-time `fixModel` is done and treat each remaining surface separately (recommended).**
    - Pros: makes clear what is left; each has a different authority shape (a UI focus versus a long-running supervisor).
    - Cons: the README forbids adding new todos to an existing file, so any split must go into new files.
  - **Keep it as one item.**
    - Pros: no churn.
    - Cons: overstates what is missing.
- **Which first, if any?**
  - **A `fixModel` override on `address_multi_review` (recommended).**
    - Pros: smallest change; same selection validation as launch; idempotent by workflow.
    - Cons: the Fix handoff is persisted once, so a second address with a different model needs a defined conflict answer.
  - **Looped review start.**
    - Pros: a real workflow with its own supervisor and controls already in the backend.
    - Cons: long-running and costly; needs budget and cancel semantics exposed to the coordinator.

### 6. Prioritise or retire the file

**Problem.** Every item is deferred and none has a user request (Open questions).

**Context.** The README rates all-deferred files low and says to re-rate when something unblocks. The index ranks this file 8 of 10, Low.

**Investigation.** Nothing in this file has moved since 2026-10-25. The coordinator surface has grown in the meantime (the schedule tools `create_schedule`, `list_schedules` and `cancel_schedule` from #1242 are now in `COORDINATOR_CONTROL_TOOL_NAMES`), which shows new tools get added when there is a request.

**Decisions.**

- **What to do with the file?**
  - **Keep it as a parking list at Low until a request arrives, then move the chosen item into a new numbered file with its design (recommended).**
    - Pros: preserves the authority caveats; follows the README rule against adding work to an existing file.
    - Cons: a list of wishes can sit indefinitely.
  - **Delete it and rely on future requests.**
    - Pros: less todo noise.
    - Cons: loses the record that each surface needs its own authority and idempotency design.

Coordinator capabilities that were deliberately kept off the platform-parity
path. They are features, not provider adapters: every qualified platform
already inspects, delegates, wakes and queues through the same interface
([`coordinator.md`](../../architecture/coordinator.md)). Moved here from
[0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md),
whose parity gaps are all closed.

## Current state

All five items are built (2026-10-27), each with its own authority,
idempotency and undo design, documented in
[`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces).
What is left is live evidence on a real stack; see **Needs verification**.

- **MCP surface.** Ten new names in `COORDINATOR_CONTROL_TOOL_NAMES`
  (`packages/protocol/src/coordinator.ts`), registered by
  `apps/backend/src/core/control-mcp-coordinator-surfaces.ts` and
  `control-mcp-review-actions.ts`, served by
  `coordinator-surface-actions.ts` and `coordinator-review-actions.ts`.
  Pi and OpenCode admit them through the shared list; Claude admits the
  whole `mcp__orkestrator__` prefix.
- **Receipts.** `withCoordinatorReceipt` (`coordinator-action-scope.ts`) over
  `actionReceipts` in the coordinator store (`storage-coordinators.ts`).
- **Worker bases.** Workers still start from a recorded base commit; the
  checkout's uncommitted changes reach one only through a user-approved
  `request_root_changes` (`root-changes.ts`, node action request kind
  `apply-root-changes`, `RootChangesApprovalDialog.tsx`).

## Outstanding work

### Code

1. ~~**Uncommitted root changes in a worker.**~~ Done: `request_root_changes`
   creates an `apply-root-changes` request; the user picks files in
   `RootChangesApprovalDialog` (the coordinator's suggestions start ticked);
   the approval applies a binary patch from `HEAD` with `git apply --check`
   then `git apply` in the worker, all or nothing. Building the patch writes
   nothing to the checkout (scratch index and object store), which
   `root-changes.test.ts` checks against real repositories. The coordinator
   invoker refuses `apply_project_root_changes` by name.
2. ~~**Terminal or tmux launch** for coordinators, building on
   `launch_terminal_job`.~~ Done: `launch_terminal` (plain command, agent
   CLI with prompt, or `claude-tmux`), with the job ID derived from the
   coordinator's request.
3. ~~**Browser launch and navigation** in a worker's preview.~~ Done:
   `open_worker_browser` opens or navigates a browser tab at a loopback
   address stored as an `agent-link` preview intent for that worker.
4. ~~**Arbitrary pane editing** (opening, closing or moving a worker's
   tabs).~~ Done: `edit_worker_tab` (focus, move, close; close runs
   `teardown_tab` and is refused under a native agent tab's running turn or
   pending question, or an open delegation). Opening is the job of the tools that create each kind
   of tab.
5. ~~**Custom-fix model switches, reviewer subtabs, looped review and
   feature-plan launch** for Multi Review and planning workflows.~~ Done:
   `custom_fix_multi_review`, `open_multi_review` with `reviewerId`,
   `start_looped_review` / `get_looped_review` / `cancel_looped_review`
   (since removed with the Looped Review feature), and
   `launch_feature_plan` / `get_feature_plan`.

Follow-ups that are outside these items (the same tools on other nodes,
status wakes for feature plans, a live-suite scenario)
are in
[0395-coordinator-worker-surfaces-follow-ups.md](0395-coordinator-worker-surfaces-follow-ups.md).

## Constraints and rationale

- Repository checkout mutation stays UI-only; it is not a coordinator tool.
  The only path from the checkout into a worker is a patch the user approves
  file by file, applied to the worker, never to the checkout.
- None of these blocks mail or delegation work, and none is a reason to give a
  platform a coordinator-only workaround.

## Assumptions and decisions

Each records the options, the choice, why, and its pros and cons.

1. **How the coordinator gets uncommitted root changes into a worker.**
   Options: (a) a launch option that copies the dirty tree at creation;
   (b) let `transfer_files` copy the files; (c) a request the user approves
   file by file, applied as a patch. Chose (c), reusing the node action
   request flow. Why: the todo requires that the user picks the files and
   that the coordinator cannot copy them on its own; the request flow
   already has a durable store, an approval dialog and an outcome mail that
   wakes the coordinator. Pros: one approval path for every
   coordinator-requested action; the coordinator never sees file contents;
   deletions and new files travel, which a file copy cannot express. Cons:
   the worker must already exist; the request is single-node; the user is
   interrupted by a dialog. Observation, not changed: `transfer_files` with
   `from: { projectRoot: true }` can already copy whole working-tree files
   (uncommitted content included) from the checkout to a worker without
   approval; it predates this todo and belongs to the command-node design.
2. **Patch mechanics.** Options: copy files; `git diff --no-index` per new
   file; `git diff HEAD` against a scratch index with intent-to-add entries.
   Chose the scratch index plus a scratch object store
   (`GIT_OBJECT_DIRECTORY`, the real store as an alternate). Why: one
   `git diff --binary` covers edits, deletions, new and binary files; the
   first version wrote the empty blob into the checkout's object store, which
   the no-write test caught, so objects now go to the scratch store. Pros: no
   write to the checkout's index, objects, refs or files; portable (no shell).
   Cons: the patch is built from `HEAD`, so a worker on another base may not
   take it.
3. **Applying a patch that does not fit.** Options: `git apply --3way`
   (conflict markers in the worker); apply what fits (`--reject`); all or
   nothing. Chose all or nothing (`--check` first). Why: a half-applied patch
   is a state nobody asked for and the user cannot see from the dialog.
   Pros: the worker is untouched on failure and the mail says why. Cons: a
   worker that diverged on one file takes none of them.
4. **Idempotency store.** Options: reuse `CoordinatorWorkflowAssociation`
   with new kinds; store a hash on each resource (tab data, request record);
   a separate bounded receipt list. Chose a separate list (`actionReceipts`,
   2,000, oldest completed dropped). Why: associations drive `list_workflows`,
   status wakes and delegation, and new kinds would reach all of them;
   resources such as terminals and feature plans have nowhere to keep a
   payload hash. Pros: one admit-before-acting rule for every new mutation,
   matching the public CLI contract; a changed payload under a reused key is
   refused. Cons: replays return the stored (bounded) result rather than live
   state, except custom fix, which re-reads its workflow.
5. **A pending receipt owned by this same process.** Options: treat it as
   reclaimable (as `reserveCoordinatorWorkflowAssociation` does, relying on
   its own in-process serialization) or as live. Chose live, plus an
   in-process map so concurrent identical calls run once. Why: the first test
   run showed that reclaiming would let two concurrent identical calls both
   act. Pros: at most one run per request per process. Cons: if releasing a
   failed receipt itself fails, the request stays pending until the backend
   restarts.
6. **Retry after a crash between effect and receipt.** Options: refuse;
   re-run blindly; re-run through each action's own identity. Chose the last:
   terminal job and browser tab IDs derive from the request, and a feature
   plan created after the receipt with the same message is found again. Pros:
   no duplicate work in the common crash windows. Cons: feature plan
   reattachment is by time and content rather than a stored ID; a plan the
   user created in the same instant could be mistaken for ours (judged
   negligible).
7. **Terminal tab types.** Options: plain only; plain plus agent CLIs and
   `claude-tmux`. Chose all that `launch_terminal_job` supports except
   `cursor` (which it refuses). Why: "terminal or tmux launch" names both, and
   agent CLIs in a worker are no more authority than `launch_job`. Pros:
   matches the user's own new-tab menu. Cons: more input combinations to
   validate (a plain tab needs `command`; agent tabs take `prompt` and
   `model`).
8. **Browser addresses.** Options: any URL; loopback only, as the address
   bar; loopback stored as a preview intent. Chose loopback `http(s)` checked
   by `parsePreviewUrlIntent`, stored as an `agent-link` intent URI. Why: the
   worker browser must not become a way around the coordinator's
   policy-gated research tools, and a container worker's `localhost:3000` is
   its own service, not the host's; the intent lets the tab resolve that.
   Pros: same rule the browser applies to an agent's link. Cons: no external
   pages, no `orkestrator-preview://service/…` IDs from the coordinator.
9. **Which tab edits.** Options: a general layout writer; focus, move and
   close only. Chose focus, move and close, each a compare-and-set that
   recomputes on the latest tree. Opening stays with the tools that know how
   to create each tab kind (`launch_job`, `launch_terminal`,
   `open_worker_browser`, `open_multi_review`). Pros: no way to write an
   arbitrary tab record; idempotent. Cons: no split or resize.
10. **Closing guards.** Options: close anything; refuse busy agent tabs;
    also refuse tabs a coordinator waits on. Chose both refusals. Why: a
    close mid-turn cuts off the report a delegation is waiting for, and a
    question a person has not answered. Conversations are kept either way
    (`teardown_tab` uses the retain-history close). Cons: an unreadable
    session is refused rather than closed.
11. **Custom fix model.** Options: extend `address_multi_review`; a separate
    tool. Chose a separate `custom_fix_multi_review` whose omitted `fixModel`
    is the review's own fix model, as the dialog's picker starts. Why: the
    default and custom fixes have different launch identities and the
    service refuses a custom fix after dispatch, so it needs its own receipt.
    The step menu's **Restart in…** is not exposed (it is recovery, not a
    launch). Cons: one more tool.
12. **Reviewer subtabs.** Options: a new tool; `reviewerId` on
    `open_multi_review`. Chose the parameter, with a deterministic tab ID.
    Pros: one place to open any part of a review. Cons: this node only.
13. **Feature plan wakes.** Options: add association kinds
    and status-wake rules now; say in the result that there is no wake.
    Chose the latter, pointing at `create_schedule`. Why: status wakes have
    per-kind ownership, budgets and restart rules that deserve their own
    change (0395). Cons: the coordinator learns the outcome only if it
    schedules a check or the user tells it.
14. **Feature plan scope.** Options: planning only; planning plus Build.
    Chose planning only. Why: Build from a plan creates a ticket, claims the
    plan and starts a build pipeline in the renderer flow; a coordinator that
    wants a build already has `start_build_pipeline`. Cons: no one-call
    plan-to-build for coordinators.
15. **Capabilities.** Terminal launch is `jobs`; browser, tab edits and the
    root-changes request are `environments`; custom fix is `multi-review`; feature plans are `tickets`. Side agents get none.
16. **Other nodes.** Options: `nodeId` on every new tool now; this node
    only. Chose this node only, refusing `reviewerId` with `nodeId`. Why: each
    needs a relayed command on the leaf and an outcome-unknown path; that is
    its own change (0395). The new backend commands are on the node-routing
    exclusion list so they never cross a link meanwhile.

## Open questions

- None.

## Needs verification

Unit and component tests cover every item; none of this has run on a real
stack with a real provider yet.

- A real coordinator (Claude and Codex at least) calling each new tool in a
  disposable `dev:test` profile, with the worker inactive and then
  reopened: the terminal, browser and reviewer tabs appear
  in the worker, and a closed tab's conversation is still in history.
- The root-changes dialog end to end in the app: approve applies to a local
  worker and to a container worker (`docker exec … git apply`), reject
  applies nothing, and both wake the coordinator once.
- `open_worker_browser` on a container worker resolves the `agent-link`
  intent to the container's service in the desktop app and in the browser
  client.

## Related

- [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md)
  (where these were listed before) and
  [`control-mcp.md`](../../architecture/control-mcp.md) for tool tiers and
  authority.
- [0395-coordinator-worker-surfaces-follow-ups.md](0395-coordinator-worker-surfaces-follow-ups.md)
  for the follow-ups.

## Replaces

- The "Product surfaces kept off the parity path" section of
  [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md).
