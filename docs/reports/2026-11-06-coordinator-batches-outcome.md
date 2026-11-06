# Coordinator batches: outcome

The closing record of the work built from the
[coordinator review](2026-10-27-coordinator.md). The findings were analysed on
2026-11-03 against `main` at `a2bba9d8` and combined into batch files on
2026-11-04. Every batch and every file built on its own has since been built
and its file deleted, in a merged pull request. C3 (Sweep and reads, #1887) was
the last. That left the folder `docs/reports/coordinator/` holding only its
index, so on 2026-11-06 the folder was retired and the index's record moved
here, checked against `main` at `abc3eea16`.

[Status of every finding](#status-of-every-finding) is the index's section as
it stood, with the same heading, so an anchor that pointed into the index names
the same section here. Links were adjusted for the new location, and the status
counts were recounted. [Parallel running](#parallel-running) keeps the
index's run-order section under its original headings, now that nothing is left
to run; [batches.md](batches.md) records the group as closed.

The **Closed in** column names the merged pull request and commit that deleted
each batch file. For a squash merge,
`git show <commit>^:docs/reports/coordinator/<file>`
reads the version on main before the pull request, which can contain only the
pre-build tasks, without the branch's outcome table. Use the outcome links in the
table below for the preserved closing records. To investigate the original
branch report, consult the corresponding pull request's branch history; its
outcome version is not necessarily retained in main's history.

## Batch record

Every batch file and every file built on its own, with the merged pull request
that deleted it and where its outcome and any work it left are recorded.

| Batch | Name | File | Closed in | Outcome and what it left |
| --- | --- | --- | --- | --- |
| C1 | Wake reliability | `0010-c1-wake-reliability.md` | #1773 (`0997e15b4`) | [Its outcome record](2026-11-04-coordinator-c1-wake-reliability-outcome.md); live checks in [4860](../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md). |
| C2 | Workflow records | `0080-c2-workflow-records.md` | #1859 (`cd7e963ec`) | [Status of every finding](#status-of-every-finding); live checks in [6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md). |
| C3 | Sweep and reads | `0110-c3-sweep-and-reads.md` | #1887 (`abc3eea16`) | [Its archived outcome](#c3-archived-outcome); what it left is in [6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md). |
| C4 | Tool surface | `0040-c4-tool-surface.md` | #1809 (`af2e566e5`) | [Status of every finding](#status-of-every-finding); live checks in [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md). |
| C5 | Prompt and context | `0030-c5-prompt-and-context.md` | #1782 (`7347e5093`) | [Status of every finding](#status-of-every-finding); what it left is in [4900](../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) and [4901](../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md). |
| C6 | Errors and dead ends | `0020-c6-errors-and-dead-ends.md` | #1844 (`a0a6d6206`) | [Status of every finding](#status-of-every-finding); what it left is in [4880](../todo/coordinator-and-multi-review/4880-c6-live-checks.md) and [6560](../todo/coordinator-and-multi-review/6560-unavailable-platform-live-checks.md). |
| C7 | Work panel and navigation | `0060-c7-work-panel-and-navigation.md` | #1835 (`cf2ef197a`) | [Status of every finding](#status-of-every-finding); what it left is in [4941](../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md), [4942](../todo/coordinator-and-multi-review/4942-c7-live-checks.md) and [6580](../todo/coordinator-and-multi-review/6580-launch-override-marker-on-another-node.md). The Work panel itself was removed on 2026-11-05 (#1889). |
| C8 | Tab strip | `0070-c8-tab-strip.md` | #1813 (`d5294b202`) | [Status of every finding](#status-of-every-finding); its follow-up, to-do 5200, is done and closed. |
| C9 | Panel split | `0190-c9-panel-split.md` | #1778 (`ce7989a50`) | [Its closing report](2026-11-05-c9-closing-report.md); no to-do. |
| C10 | Explanations | `0240-c10-explanations.md` | #1851 (`14e8242e1`) | [Status of every finding](#status-of-every-finding); every task was done, so no to-do. |
| C-0390 | Panel re-render cost | `0390-panel-re-render-cost.md` | #1854 (`009da1548`) | [Status of every finding](#status-of-every-finding); no to-do. |
| C-0410 | Leaf-mode gate edge cases | `0410-leaf-mode-gate-edge-cases.md` | #1802 (`ec4d32c09`) | The U13 leaf-mode gate row below; no to-do. |
| X1 | Coordinator trust boundary | `0090-x1-coordinator-trust-boundary.md`, in `docs/reports/security/` | #1853 (`41f9eb638`) | [The security index](security/0000-index.md); what it left is in [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md). |

## Rows with work still open

Every status row that is not done, checked on 2026-11-06 against the to-do it
names. Each to-do exists and still lists the work as open, so this retirement
raised no new to-do.

| Row | Disposition | Open work |
| --- | --- | --- |
| S1 and 7: live read-only step for mailing the home | Partly done | [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 1. |
| B1: store-full visibility and swallowed delegation open | Partly done | [6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md) task 4. |
| B1: list walked long before the cap | Partly done | [6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md) task 1. |
| B4: forgotten-node delegations never close | Partly done | [6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md) tasks 1 to 3. |
| A5: tool surface and legacy node tools | Partly done | [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md) tasks 1 and 2. |
| A7: prompt nudges toward over-delegation | Partly done | [4900](../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) tasks 1 and 2. |
| U13: prompt subscriptions | Partly done | [4942](../todo/coordinator-and-multi-review/4942-c7-live-checks.md) task 1. |
| 5.5: idle feedback | Partly done | [4941](../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md) task 1. |
| 5.1: Work rail | Withdrawn | [6580](../todo/coordinator-and-multi-review/6580-launch-override-marker-on-another-node.md) task 1, the launch-override marker on another node. |

Rows recorded as done can still name a to-do for live evidence: A2
([4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md)
task 3), B5 and the delegation decision
([4860](../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md)
tasks 1 and 2) and U3 ([4880](../todo/coordinator-and-multi-review/4880-c6-live-checks.md)).
C3's per-wake repair is [6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md)
task 2.

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](batches.md),
which now lists this group under its closed groups.

Batches in the same lane ran one at a time, in the order shown. Batches in different lanes could run together unless **Not at the same time as** named the other one. A batch with no lane only had to respect that column.

The index only changed when a branch merged, so it could not show what was running. Before a batch started, the running environments and open PRs for its lane and its **Not at the same time as** list were checked, which is why each batch ID was put in its environment and branch name. The group is closed, so nothing is left to check.

### Batches

None. C3 (Sweep and reads) was the last, and is closed; every batch is in the [batch record](#batch-record).

### Files built on their own

None. C-0390 (Panel re-render cost) was the last, and is closed; every file built on its own is in the [batch record](#batch-record).

## Status of every finding

58 done, 8 partly done, 1 withdrawn, 0 open, 7 no action.

Batch C3 (Sweep and reads) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `cd7e963ec`; its measurement, task-by-task outcome table and the list of paths that open a main are preserved in [C3: archived outcome](#c3-archived-outcome).
On an isolated store of 40 coordinators and 1,800 workflow records, one sweep went from about 800 ms to about 55 ms and one coordinator read from about 16 ms to about 5.5 ms. What it left, pruning below the limit and the per-wake repair in a sweep's wake pass, is in to-do
[6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md).

Batch C2 (Workflow records) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `41f9eb638`; its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C2')"`.
What it could not prove without real machines or a live stack is in to-do
[6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md).

Batch X1 (Coordinator trust boundary) is closed; [the security index](security/0000-index.md) has its record, and what it left is in to-do [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md).

Batch C9 (Panel split) is closed. Its task-by-task outcomes are in the [closing report](2026-11-05-c9-closing-report.md).

Batch C-0390 (Panel re-render cost) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `1c2f12837`; its measurement, decision and task-by-task outcome table end the report in the parent of the commit that deleted it. In a component-browser fixture with three conversation groups, 50 unrelated environment, build pipeline or Multi Review writes committed every group's transcript controller 102 times and took 450–590 ms of panel commit time; after the change they commit no controller and take 76–96 ms. No to-do was needed.

Batch C4 (Tool surface) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `7347e5093`; its task-by-task outcome table ends the report in the parent of the commit that deleted it. What it could not prove without real provider turns is in to-do [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md).

Batch C5 (Prompt and context) is closed. What it could not prove without real provider turns or real transcripts is in to-dos [4900](../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) and [4901](../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md).

Batch C7 (Work panel and navigation) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C7')"`.
The Work panel itself was removed on 2026-11-05. What it left is in to-dos
[4941](../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md),
[4942](../todo/coordinator-and-multi-review/4942-c7-live-checks.md) and
[6580](../todo/coordinator-and-multi-review/6580-launch-override-marker-on-another-node.md).

Batch C8 (Tab strip) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C8')"`.
What it left, tab semantics on the environment strip, is done and to-do 5200
is closed.

Batch C6 (Errors and dead ends) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C6')"`.
What it left is in to-dos
[4880](../todo/coordinator-and-multi-review/4880-c6-live-checks.md) and
[6560](../todo/coordinator-and-multi-review/6560-unavailable-platform-live-checks.md).

Batch C10 (Explanations) is closed. It was built from `main` at `a0a6d6206`. Its
task-by-task outcome table ends the last version of its deleted report, which
the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C10')"`.
Every task was done, so it left no to-do.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| S1: `send_message` can write through the project home | Done | Reason and approval gate at `apps/backend/src/core/coordinator-worker-mail.ts:417-432` (`5161688cf`, #1632), which supersedes the report's refusal. |
| S1: reachable through `create_schedule` | Done | The schedule calls the same tool with no reason field: `scheduled-jobs/tools.ts:219-229`, `scheduled-jobs/executor.ts:594-596`. |
| S1: home unmarked in `list_environments` | Done | `projectHome: true` on the coordinator's row only (`control-mcp-tools.ts`, `list_environments`); the batch that built it is X1. |
| S1: one helper for every home check | No action | Superseded: the message route is now a designed exception, and `control-mcp-server.ts:603` refuses the others. |
| S1: regression test | Done | `apps/backend/src/core/coordinator-worker-mail.test.ts`, `control-mcp-server-messaging.test.ts`. |
| S1 and 7: live read-only step for mailing the home | Partly done | The step exists and is checked offline (`homeMailGateFailures`, `coordinator-live.ts`). Its live run is [6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 1. |
| S2: side agents can adopt workflows | Done | Refused in `adopt_coordinator_workflow` (`commands-registry-coordinator.ts`); the backend's `force` takeover is unaffected. |
| S2: doc drift on side-agent capabilities | Done | `docs/architecture/coordinator.md:351-353` (`3fa7d1733`, #1436). |
| B1: associations never pruned | Done | `storage-coordinators.ts:146-174`, `coordinator-workflow-retention.ts` (`b0dcf1660`, #1620). |
| B1: request aliases kept without limit | Done | Arrival timestamps and expiry, `docs/architecture/coordinator.md:87-90` (`b0dcf1660`). |
| B1: store-full visibility and swallowed delegation open | Partly done | `send_message`'s `warning` when the delegation did not open, and `workflowStore` on the snapshot with `CoordinatorWorkflowStoreBanner` (`coordinator-workflow-retention.ts`, `storage-coordinators.ts`, `CoordinatorPanelNotices.tsx`), tested in `coordinator-worker-mail.test.ts`, `control-mcp-server-messaging.test.ts`, `coordinator-workflow-retention.test.ts` and `CoordinatorWorkflowStoreBanner.test.tsx`. The banner on a live stack: [6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md) task 4. |
| B1: per-project cap | Done | Kept shared, with the reason in the `MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS` comment and `docs/architecture/coordinator.md` (Workflow record limit and cleanup). |
| B1: list walked long before the cap | Partly done | Measured on an isolated store (C3): 1,400 finished records add 5 to 8 ms to a 60 s sweep and about 2 ms to a read, so nothing prunes below the limit yet. A measurement on a real large store: [6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md) task 1. |
| B2: no per-item catch in wake and reconcile loops | Done | `deliverDelegationWakesOnce` and `reconcileWorkerDelegations` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. A wake that keeps failing is retired with one notice (`wakeFailedAt`). |
| B3: delegation closing mid-pass delayed | Done | `runDelegationWakePasses` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| B4: forgotten-node delegations never close | Partly done | `CoordinatorService.nodesReleased` from `NodeService`'s `onNodesReleased` on forget and handover, the sweep's release of unregistered nodes, and a once-per-episode notice for a node unreachable for a day (`coordinator-node-release.ts`), tested in `coordinator-node-release.test.ts`, `nodes/node-service.test.ts` and `nodes/node-handover.test.ts`. Two-node runs: [6360](../todo/coordinator-and-multi-review/6360-c2-workflow-records-live-checks.md) tasks 1–3. |
| B5: held notices dropped after 24 h | Done | `coordinator-status-backfill.ts`, tested in `coordinator-status-wakes.test.ts`. Whether the remaining rule can go: [4860](../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md). |
| B6: close during wake delivery | Done | The re-check before `markCoordinatorDelegationWoken` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| B6: waiting cleared only on working | Done | `endWaitingEpisode` in `coordinator-status-wakes.ts`, tested in `coordinator-status-wakes.test.ts` and `coordinator-remote.test.ts`. |
| B7: repair sweep and snapshot cost | Done | One mailbox sync and owed-set read per sweep (`reconcileClosedConversations`, `coordinator-closed-conversations.ts`), open delegations re-read only after a store change (`coordinator-open-delegations.ts`), and a wake of two writes and one announcement (`closeOnDecision`, `coordinator-service.ts`); tested in `coordinator-sweep.test.ts`. Batch C3. |
| A1: delegation prompt with messaging off | Done | `coordinatorDelegationAvailable` in `coordinator-context-reads.ts`, `withoutWakePromise` in `control-mcp-tools.ts`, the notice in `CoordinatorToolbar.tsx`; tested in `native-agent-service-base.test.ts`, `control-mcp-server-coordinator-workflows.test.ts`, `CoordinatorPanel.test.tsx`. |
| A2: `agent` cannot be omitted | Done | `agent` is optional on `launch_environment` and `launch_job` and resolves to the saved default (`resolveLaunchAgent`, `control-shared-actions.ts`); tested in `control-mcp-server-launch.test.ts`, `control-mcp-operator-tools.test.ts`, `commands-registry-coordinator.test.ts`. A live check that models omit it: [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md) task 3. |
| A3: request-id namespace | Done | `COORDINATOR_REQUEST_ID_RULE` in the context and instructions, `COORDINATOR_REQUEST_ID_REUSED_ERROR` on every collision, `replayed: true` on replays, and a pre-send check in `send_message` (`coordinator-worker-mail.ts`); the namespace stays per coordinator, as the report recommended. Tested in `coordinator-worker-mail.test.ts`, `commands-registry-coordinator.test.ts`, `coordinator-review-actions.test.ts`, `coordinator-context.test.ts`. |
| A4: poll-guard coverage | Done | `control-mcp-poll-guard.ts`: semantic keys, a sliding window, and the guard on `list_agents`, `get_environment`, `get_tab_state`, `get_tab_transcript`, `get_build_pipeline`, `get_multi_review` and `list_workflows`; `list_agents` no longer invites polling. Tested in `control-mcp-poll-guard.test.ts`, `control-mcp-server-reads.test.ts`. |
| A5: tool surface and legacy node tools | Partly done | Six legacy node tools and the coordinator's `start_multi_review` removed (`RETIRED_COORDINATOR_TOOLS`, `control-mcp-tools.ts`; `read_node_environment` kept for remote file reads); surface measured and bounded at 82 tools and 115,114 bytes, from 89 and 125,040 (`control-mcp-coordinator-schema-size.test.ts`). Per-provider cost and trimming the field copies of context rules: [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md). |
| A5: project name and open delegations in the context | Done | `projectLine` and the `Waiting on` line in `packages/protocol/src/coordinator-context.ts`, read by `readCoordinatorWaitingOn`; tested in `coordinator-context.test.ts`, `coordinator-context-reads.test.ts`. Its cache cost: [4901](../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md). |
| A6: delegation state for the agent | Done | The `delegation` summary and `openOnly` on `list_workflows` (`control-mcp-coordinator-tools.ts`), and `coordinatorDelegationBucket` shared with the Work panel; tested in `control-mcp-server-coordinator-workflows.test.ts`. |
| A6: cancel a delegation or interrupt a worker turn | Done | `stop_worker_turn`, `control-mcp-coordinator-worker-turns.ts:61` (`fbdea704c`, #1507). |
| A6: worker diff read | Done | `get_worker_changes`, `control-mcp-coordinator-worker-tools.ts:75` (`fbdea704c`, #1507). |
| A7: prompt nudges toward over-delegation | Partly done | [4900](../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) (`COORDINATOR_ROUTING_RULE` now offers an idle worker first; softening the read rule waits on a check of real transcripts). |
| A7 note: safety-level reason | Done | The setting sentence comes first, then the platform's caveat: `COORDINATOR_SAFETY_LEVEL_REASON`, `coordinator-providers.ts`, tested in `coordinator-providers.test.ts`. |
| U1: waiting chip with Open buttons | Done | Replaced by the Work panel (`eb6bf887a`, #1698), which was removed on 2026-11-05. |
| U1: Open from mail tiles and the banner | Done | Open on worker notices (`MailTile.tsx`, `workerTabTarget`, `notice.resource.nodeId`) and on the banner (`HumanPromptBanner.tsx`), tested in `MailTile.test.tsx`, `HumanPromptBanner.test.tsx` and `CoordinatorPanel.test.tsx`. |
| U2: confirm closing the main | Done | `CoordinatorPanel.tsx:473-478`, `:569-596` (`e5245dfd6`, #1644). |
| U2: Change agent and main-tab marker | Done | Change agent and the Main label, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPanel.tabs.test.tsx`. The replacement main retains the original group and tab index, including layout edits made while creation is pending. |
| U3: failure replaces the main's transcript | Done | Now a banner, `CoordinatorPanel.tsx:397-412` (`e5245dfd6`, #1644). |
| U3: failure scoped to the conversation | Done | `CoordinatorConversation.startupError` and `coordinatorConversationRunnable` (`packages/protocol/src/coordinator.ts`), with Retry, Close conversation and Copy error in that pane (`CoordinatorStartupFailure`). See `docs/architecture/coordinator.md`, "When a conversation fails to start". Real providers: [4880](../todo/coordinator-and-multi-review/4880-c6-live-checks.md). |
| U4: Git error masks action errors | Done | Separate lines, `CoordinatorToolbar.tsx:109-111`, `:213-216` (`e5245dfd6`, #1644). |
| U4: collapsed, with no `role="alert"` | Done | `CoordinatorActionAlert`, `CoordinatorPanelNotices.tsx`, tested in `CoordinatorPanel.outcome.test.tsx`. Git's retained error stays a disclosure. |
| U5: Git actions gated on the wrong turn | Done | Any active turn disables them and is named: `useCoordinatorActiveTurn.ts`, `coordinator-checkout-turn.ts`, `CoordinatorToolbar.tsx:94-98`. |
| U6: pausing hides the transcript | Done | Paused panes read saved history and establish nothing: `sendingHeldReason` (`AgentNativeTab.controller.tsx`, `useNativeAgentSession.ts`) and `heldCoordinatorConversation` (`coordinator-runtime.ts`), tested in `native-agent-service-held-coordinator.test.ts`. |
| U7: chip disappears with focus | Done | The Work panel covers every conversation, `docs/architecture/coordinator.md:997-1002` (`eb6bf887a`, #1698). |
| U8: side agents never explained | Done | New side agent's tooltip, and a side composer's own placeholder and hint (`COORDINATOR_SIDE_AGENT_EXPLANATION`, `CoordinatorPanel.tsx`, `CoordinatorConversationPane.tsx`), tested in `CoordinatorPanel.tabs.test.tsx` and `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| U9: dead-end states and scattered settings | Done | Buttons on the provider banner, empty-platform message and no-checkout card, and a Coordinator section in Settings: `CoordinatorConversationPane.tsx`, `CoordinatorPanel.tsx`, `GlobalSettings.sections.tsx`, tested in `CoordinatorPanel.outcome.test.tsx` and `GlobalSettings.coordinator-section.test.tsx`. |
| U10: first sends in two groups | Done | One held prompt per conversation: `useCoordinatorLaunches.ts`. |
| U11: accessibility | Done | Tab semantics, keyboard tab moves and a labelled spinner: `CoordinatorPaneTree.tsx`, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPaneTree.test.tsx` and `CoordinatorPanel.tabs.test.tsx`. The environment strip, deliberately left, followed in to-do 5200, now closed: `DraggableTab.tsx`, `DraggableTabBar.tsx`. |
| U12: re-render cost | Done | Measured, then narrowed: `CoordinatorWorkerPrompts.tsx` owns the prompts banner's store subscriptions beside the conversations (it held the removed Work panel's too), `useCoordinatorActiveTurn.ts` selects only home environment ids, and `CoordinatorConversationPane.tsx` gives the memoized agent tab stable props; tested in `CoordinatorPanel.render-cost.test.tsx` and `useCoordinatorActiveTurn.test.tsx`. Batch C-0390, above. |
| U13: `Context rN` jargon | Done | Moved into the badge's details (`e5245dfd6`, #1644), a menu since C10 (`CoordinatorIsolationBadge`, `CoordinatorPanelNotices.tsx`). |
| U13: `!` commands | Done | A hint under every coordinator composer, a footer about the coordinator's own work, and the first-message rule shown inline under the composer (`COORDINATOR_COMMAND_HINT`, `FIRST_MESSAGE_COMMAND_RULE` in `AgentNativeTab.helpers.tsx`), tested in `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| U13: leaf-mode gate | Done | `LeafModeCoordinatorGate.tsx` waits for portal status, names "the command node" when no controller is known, and remembers "open anyway" per project for the app session (`openedLeafCoordinators`, `uiStore.ts`); tested in `leaf-mode-coordinator-gate.test.tsx`. Batch C-0410; outcome table in the report's last version before deletion. |
| U13: prompt subscriptions | Partly done | Retention bounds the set. Remote prompts reach the banner (`useRemoteHumanPrompts.ts`, tested with fakes); two real nodes: [4942](../todo/coordinator-and-multi-review/4942-c7-live-checks.md). |
| U13: picker caveats and tier name | Done | The appended "cannot verify" sentence is gone, and each platform's tier is named in the picker (`platformBadges`, `AgentModelPicker.tsx`), tested in `CoordinatorPanel.test.tsx` and `AgentModelPicker.test.tsx`. Batch C10. |
| U13: tab click writes selection twice | Done | `focusesPane` and `coordinatorDragEndChange` in `CoordinatorPaneTree.tsx`, tested in `CoordinatorPanel.tabs.test.tsx` and `CoordinatorPaneTree.test.tsx`. |
| U13: narrow screens | Done | Icon-only New side agent, Sync and Pause, and a badge showing only its icon and tier name, below `sm` (`CoordinatorPanel.tsx`, `CoordinatorToolbar.tsx`, `CoordinatorPanelNotices.tsx`); the toolbar fits one row at 390 px. |
| U13: research Add limit and Enter | Done | `CoordinatorWebResearchSettings.tsx`, tested in `CoordinatorWebResearchSettings.test.tsx`. |
| U13: research duplicate check is case-sensitive | No action | Names can only be lowercase, `packages/protocol/src/coordinator-web-research.ts:56`. |
| 5.1: Work rail | Withdrawn | Built in `eb6bf887a`, #1698, with request, agent, model, age and Stop added later; the whole panel was removed on 2026-11-05 as not worth its space. The local worker tab now marks launch overrides; on another node: [6580](../todo/coordinator-and-multi-review/6580-launch-override-marker-on-another-node.md). |
| 5.2: first-run card and starter prompts | Done | Starter prompts in `e5245dfd6` (#1644); the dismissible first-run card and the toolbar's "?" in `CoordinatorIntro.tsx`, dismissed per user in the UI store (`coordinatorIntroDismissed`), tested in `CoordinatorPanel.outcome.test.tsx` and `uiStore.persistence.test.ts`. Batch C10. |
| 5.3: legible read-only tier | Done | A tier pill on the toolbar badge and in the picker; the badge's menu gives the tier's meaning and links Settings → Coordinator (`CoordinatorIsolationBadge`, `CoordinatorPanelNotices.tsx`), tested in `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| 5.4: error rule and stale indicator | Done | `readFailuresFreshnessNotice` (`view-freshness.ts`) shown by `CoordinatorToolbar.tsx`, tested in `useCoordinatorPanelData.test.tsx`; the rule's other parts came with U3, U4 and U9. |
| 5.5: idle feedback | Partly done | A report cue (`useNotificationSoundService.ts`); the Work panel and its next-wake line were removed on 2026-11-05. A desktop notification: [4941](../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md). |
| 6: `CoordinatorPanel` does too much | Done | Split from 1,256 to about 600 lines: `CoordinatorToolbar.tsx`, `CoordinatorConversationPane.tsx`, `useCoordinatorSelection.ts`, `useCoordinatorLaunches.ts`, `useCoordinatorGitActions.ts`. |
| 6: repeated action handling and one busy flag | Done | `runAction` with separate Git and conversation flags: `useCoordinatorActions.ts`. |
| 6: delegation decision in three places | Done | `coordinator-delegation-decision.ts`, tested in `coordinator-delegation-decision.test.ts`. The remote goal hold it added needs live proof: [4860](../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md). |
| 6: reads that write | Done | `snapshot()` repairs nothing; every path that opens a main (`ensure` and `createConversation` included) goes through `ensureMainConversation`, which runs the repair, as does a conversation close, and the sweep covers the rest; tested in `coordinator-sweep.test.ts`. Batch C3. |
| 6: partial serialization | Done | `mutateSerialized` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| 6: copied mailbox check and hand-built runtime ids | Done | `assertOwnMailbox` in `control-mcp-tools.ts` for `read_messages`, `get_message` and `ack_message`, and `coordinatorRuntimeId` in `control-mcp-tools.ts`, `control-mcp-server.ts` and `scheduled-jobs/service.ts`; tested in `control-mcp-server-messaging.test.ts`. Batch C3. |
| 6: duplicated request-alias lookup | Done | `coordinatorRequestAlias` and `coordinatorRequestMatch` in `coordinator-workflow-retention.ts`, used by every alias lookup; tested in `coordinator-workflow-retention.test.ts`. |
| 6: context prompt built inline | Done | `buildCoordinatorContext` in `packages/protocol/src/coordinator-context.ts`, tested in `coordinator-context.test.ts`. |
| 1: Top 10 actions | No action | Each restates a finding above. |
| 2: how it works today | No action | A description, not work. |
| 3: strengths worth keeping | No action | Strengths, not work. |
| 7: roadmap | No action | Restates the findings above, apart from the live step listed under S1. |
| 8: notes on this report | No action | Notes only; this split is what section 8 asks for. |

## C3: archived outcome

The following outcome is copied from the C3 branch report at `b0fbe4ee1^`,
before its final deletion. It records the historical build and measurements,
not new validation. Keeping it here preserves the detail without requiring that
unmerged branch commit to remain available. Relative links were adjusted for
this report's location.

Built from `main` at `cd7e963ec` (C2, #1859, already merged). Every finding was re-checked against that commit first: the line numbers had moved, but every finding still held and none was already done.

### Measurement

`apps/backend/scripts/coordinator-sweep-bench.ts` builds an isolated synthetic store in the system temporary directory: 40 projects, each with one coordinator, 10 running delegations (each on a running local environment) and 35 closed and woken ones, so 1,800 of the 2,000 workflow records. It times one `reconcileWorkerDelegations` (the 60 s sweep), one `CoordinatorService.get` (`get_project_coordinator`, and every coordinator `read_messages`) and one `get_project_coordinator_view` (the panel), 20 times each, on the same host, before and after. "Before" ran this branch's script with `coordinator-service.ts` and `storage-coordinators.ts` checked out at `cd7e963ec`. Mean milliseconds per call, two runs each:

| Store | Sweep before | Sweep after | Read before | Read after | View before | View after |
| --- | --- | --- | --- | --- | --- | --- |
| 1,800 records (1,400 finished) | 797, 846 | 53, 56 | 15.7, 15.9 | 5.2, 5.6 | 15.5, 16.1 | 5.4, 6.0 |
| 400 records (none finished) | 398, 400 | 48, 48 | 9.5, 9.6 | 3.3, 3.5 | 9.6, 9.7 | 3.4, 3.5 |

The store owed no repair, so neither version wrote during these runs (0 coordinator and 0 agent mail store revisions per call). That reads do not write when repair is owed is shown by `coordinator-sweep.test.ts` rather than by the timing.

### Task by task

| Part, task | Outcome | Evidence |
| --- | --- | --- |
| 0110, 1: sync once per sweep | Done | `reconcileClosedConversations` (`coordinator-closed-conversations.ts`) adopts per coordinator from one `getCoordinatorReconciliationState` read, then syncs mailboxes once and reads the owed set once (`listOwedCoordinatorDelegationIds`, one read for open and unwoken) for every coordinator's mail move. Each move reads the mail store afresh under its lock and only touches its own coordinator's mailboxes; adoption does not change which delegations are owed, so one owed set holds for the pass. The per-delegation re-check under the worker's admission lock uses one read and reads again only after the store revision moved (`readOpenDelegations`, `coordinator-open-delegations.ts`; `coordinatorStoreRevision`). Tests: "runs the mailbox sync and the delegation scans once for several coordinators", "re-checks a delegation against a fresh read once the store has changed", "moves each closed main's mail to its own next main in one pass" (`coordinator-sweep.test.ts`). |
| 0110, 2: read-only `snapshot()` | Done | `snapshot()` calls no repair. Test: "repairs nothing and writes nothing; the sweep still does the repair" reads through `get`, `get_project_coordinator` and `get_project_coordinator_view` with an adoption owed and checks no coordinator store revision, no change announcement, no mailbox sync and no mail move. The paths that open a main are listed below. Closing a conversation runs its own repair, which the read after it used to do, so a closed side's open work still moves to the main at once (test: "closing a side conversation still moves its open work to the main at once"). |
| 0110, 3: batch the wake writes | Done, as recommended | `closeOnDecision` closes with the wake kind in the same write, unannounced. The kind is chosen inside `closeCoordinatorDelegation`'s store lock from the record's own coordinator, so the main cannot close in between; with no main open it is left unset and the wake pass chooses and writes it as before. `wokenAt` stays a separate write after delivery and is the one announcement; a wake that stops short of it announces the close once after its attempt. `prepareCoordinatorDelegationWake` no longer announces. Tests: "with a report/notice writes close and kind, delivers, then stamps, announcing once" (two writes, delivery after the first, one announcement at the second), "with a report/notice, a crash between delivery and its stamp wakes once" (a restart in that gap leaves one message), "that cannot be delivered still announces its close once". |
| 0110, 4: prune below the limit | Not done: the measurement does not show it is needed | At 40 coordinators, 1,400 finished records add 5 to 8 ms to a sweep that runs every 60 s, and about 2 ms to a read or view. Pruning earlier would remove `list_workflows` history the docs promise to keep. The synthetic store is the only evidence; a real large store was not available here. Open in [to-do 6660](../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md), task 1. |
| 0370, 1: one own-mailbox check | Done | `assertOwnMailbox(invoke, scope, input, verb)` on `ownConversationMailbox`, used by `read_messages`, `get_message` and `ack_message`, with the same two error texts. Test: "a coordinator reads and acknowledges only its own conversation's mailbox" (`control-mcp-server-messaging.test.ts`), which refuses another conversation's mailbox and the wrong tab for all three tools without reaching the mail store, and allows its own. |
| 0370, 2: `coordinatorRuntimeId` everywhere | Done | `control-mcp-tools.ts` (the helper and `get_message_status`), `control-mcp-server.ts` (the invoker's own-runtime check) and `scheduled-jobs/service.ts` (`coordinatorConversationClosed`). No `coordinator:${…}` template remains in those files. The protocol's `scheduleOwnerKey` still builds the same string for side schedules; it is outside the files this part named and was left alone. |

### Paths that open a main

Checked against every writer of a coordinator workspace in `apps/backend/src`. Every path that opens a main goes through `ensureMainConversation`, which runs the repair (`reconcileMainMail`: live work, then the mailbox sync and the closed main's mail) after it opens or finds the main:

- Directly, with the default agent for an unassigned main and all other conversations' live work: mail to `coordinator` or to a closed conversation (`mainMailAddress`, the storage mail resolver), every delegation wake, the node-release notice address (`CoordinatorNodeReleases.mainAddress`) and a new notice (`startMainForNotice`).
- `ensure` creating a coordinator: after its write it calls `ensureMainConversation(projectId, { opened: true })` for its first main (nothing to move yet).
- `createConversation` with no main open (**Start coordinator**, **Change agent**): after its write it calls `ensureMainConversation(projectId, { opened: true })`. The `opened` form keeps the main the user just opened unassigned and takes over only what closed conversations left, so open side conversations keep their own work, as before.
- Both callers log a failed repair rather than failing the write; the sweep repeats it. Test: "every path that opens a main goes through ensureMainConversation" (`coordinator-sweep.test.ts`).
- No call path: a record from before roles that `normalizeCoordinatorRoles` gives a main on read or write, and a restored or imported store. These take the mail over on the next sweep, within 60 s.

Every other workspace writer (`project-git-service.ts`, `commands-servers.ts`, `commands-local-server-lifecycle.ts`, `native-agent-service.ts`, `index.ts`) only updates fields of conversations that already exist.

### Decisions

- **Re-reading open delegations in the sweep.** The re-check under each worker's admission lock is kept, because a turn end, a stop or a follow-up can change the record between the sweep's read and the lock. Chosen: compare the store's committed revision (`coordinatorStoreRevision`, one SQLite row) and read again only when it moved. Alternatives: drop the re-check (cheapest, but would decide on stale `stopRequestedAt` or `requestedAt`); read one record by id (still parses the whole store, which is what costs). The sweep that closes nothing now reads the list once.
- **Where the wake kind is chosen at close.** Chosen: inside `closeCoordinatorDelegation`'s lock, from the coordinator record in the same loaded store, so a main close cannot land between the choice and the write. The earlier separate write read held mail after the close had committed; the merged one reads it just before. A worker report already past its hold decision when the close commits could be missed either way; a report sent after the close is never held, so the choice cannot otherwise go stale.
- **How `ensure` and `createConversation` open their main.** Chosen: both call `ensureMainConversation` with `{ opened: true }`, which skips the default-agent assignment and the open side conversations' work, so every path that opens a main has one entry point and a new conversation stays unassigned. Alternatives: calling the shared repair step directly (the first version of this batch; keeps behaviour but leaves two entry points); calling plain `ensureMainConversation` (one entry point, but assigns the default agent to a conversation whose provider is the user's first choice). The calls run after each method's own serialized write, because the per-project queue is not re-entrant.
- **Splitting `coordinator-service.ts`.** The service would have reached 2,146 lines, so the closed-conversation repair moved to `coordinator-closed-conversations.ts` and the open-delegation lookup to `coordinator-open-delegations.ts`, as modules taking the storage they need (1,994 lines left after the main-opening change).
