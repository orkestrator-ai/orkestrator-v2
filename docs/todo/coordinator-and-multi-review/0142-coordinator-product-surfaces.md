# Coordinator product surfaces

Checked against `main` at `863b5782` (2026-10-27).

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
   `teardown_tab` and is refused under a running turn, a pending question or
   an open delegation). Opening is the job of the tools that create each kind
   of tab.
5. ~~**Custom-fix model switches, reviewer subtabs, looped review and
   feature-plan launch** for Multi Review and planning workflows.~~ Done:
   `custom_fix_multi_review`, `open_multi_review` with `reviewerId`,
   `start_looped_review` / `get_looped_review` / `cancel_looped_review`, and
   `launch_feature_plan` / `get_feature_plan`.

Follow-ups that are outside these items (the same tools on other nodes,
status wakes for looped reviews and feature plans, a live-suite scenario)
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
   state, except custom fix and looped review, which re-read their workflow.
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
   terminal job and browser tab IDs derive from the request, a looped review
   started after the receipt is reattached, and a feature plan created after
   the receipt with the same message is found again. Pros: no duplicate work
   in the common crash windows. Cons: looped review and feature plan
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
13. **Looped review and feature plan wakes.** Options: add association kinds
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
    root-changes request are `environments`; looped review and custom fix are
    `multi-review`; feature plans are `tickets`. Side agents get none.
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
  reopened: the terminal, browser, looped-review and reviewer tabs appear
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
