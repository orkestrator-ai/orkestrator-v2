# Coordinator product surfaces

Checked against `main` at `20f6de91` (2026-10-25).

## Task analysis

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

Coordinator capabilities that do not exist yet and are deliberately kept off
the platform-parity path. They are features, not provider adapters: every
qualified platform already inspects, delegates, wakes and queues through the
same interface ([`coordinator.md`](../../architecture/coordinator.md)). Moved
here from
[0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md),
whose parity gaps are all closed.

## Current state

- **MCP surface.** `COORDINATOR_CONTROL_TOOL_NAMES` in
  `packages/protocol/src/coordinator.ts` is the full list of coordinator tools.
  A backend `launch_terminal_job` command exists
  (`apps/backend/src/core/commands-registry-terminal.ts`) but is not exposed to
  coordinators.
- **Worker bases.** Workers start from a recorded base commit
  (`coordinatorBase` from `get_launch_options`); uncommitted root changes are
  never copied into a worker.

## Outstanding work

### Code (deferred)

Each needs its own authority and idempotency design before it is exposed:
what the credential may target, what a retry with the same `requestId` does,
and what the user sees and can undo.

1. **Uncommitted root changes in a worker.** A user-selected patch of the root
   checkout's uncommitted changes, applied to a new worker. The user picks the
   files; the coordinator cannot read or copy them on its own.
2. **Terminal or tmux launch** for coordinators, building on
   `launch_terminal_job`.
3. **Browser launch and navigation** in a worker's preview.
4. **Arbitrary pane editing** (opening, closing or moving a worker's tabs).
5. **Custom-fix model switches, reviewer subtabs, looped review and
   feature-plan launch** for Multi Review and planning workflows.

## Constraints and rationale

- Repository checkout mutation stays UI-only; it is not a coordinator tool.
- None of these blocks mail or delegation work, and none is a reason to give a
  platform a coordinator-only workaround.

## Open questions

- Which of these is wanted first? None has a user request attached yet.

## Needs verification

- Nothing yet.

## Related

- [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md)
  (where these were listed before) and
  [`control-mcp.md`](../../architecture/control-mcp.md) for tool tiers and
  authority.

## Replaces

- The "Product surfaces kept off the parity path" section of
  [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md).
