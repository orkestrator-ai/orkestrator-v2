# Coordinator review: outstanding work

What is left to do from the [coordinator review](../2026-10-27-coordinator.md).

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.
Batch C1's task-by-task outcome is in
[its outcome record](../2026-11-04-coordinator-c1-wake-reliability-outcome.md).

A batch file combines several reports as numbered parts and takes the rating of its most serious part. A number such as `0720` in this index names a part or a file, and the table below shows where it lives.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0090-x1-coordinator-trust-boundary.md](../security/0090-x1-coordinator-trust-boundary.md) | High | No | **X1, Coordinator trust boundary.**<br>`Security 0090`: M11: delegation scope and marking mail-originated delegations<br>`Security 0180`: L16: operator token reads, confirm token wording, self-reminder framing<br>`Security 0210`: I2: two stale statements about side agents<br>`Coordinator 0120`: Labelling the home in `list_environments` and a live read-only step for the message gate.<br>`Coordinator 0310`: Refusing `adopt_workflow` from a side agent. | From `Security 0090`: An injected worker can reach a user-created environment under its looser policy, limited only by framing and budgets. |
| 2 | [0080-c2-workflow-records.md](0080-c2-workflow-records.md) | Medium | No | **C2, Workflow records.**<br>`0080`: The swallowed delegation-open error, showing store-full to the user, and settling the shared cap.<br>`0100`: Closing work when a node is forgotten, and a notice for a long-offline node.<br>`0380`: One shared alias lookup.: Duplicated request-alias lookup | From `0080`: Retention makes it rare, and what remains is a functional gap when every record is in use. |
| 3 | [0110-c3-sweep-and-reads.md](0110-c3-sweep-and-reads.md) | Medium | No | **C3, Sweep and reads.**<br>`0110`: Syncing once per sweep, a read-only `snapshot()`, batched wake writes and pruning below the limit.<br>`0370`: One own-mailbox check, and `coordinatorRuntimeId` everywhere. | From `0110`: Real repeated work that has not been measured, so it removes a risk rather than a known slowdown. |

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](../batches.md).

Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless **Not at the same time as** names the other one. A batch with no lane only has to respect that column.

This index only changes when a branch merges, so it can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its **Not at the same time as** list. Put the batch ID in the environment and branch name so that check can find it.

### Batches

| Batch | Name | Parts | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| X1 | [Coordinator trust boundary](../security/0090-x1-coordinator-trust-boundary.md) | `0120` task 1, `0310`; also security `0090`, `0180`, `0210` | Coordinator backend, 1 of 3 | None | None |
| C2 | [Workflow records](0080-c2-workflow-records.md) | `0080`, `0100`, `0380` | Coordinator backend, 2 of 3 | None | None |
| C3 | [Sweep and reads](0110-c3-sweep-and-reads.md) | `0110`, `0370` | Coordinator backend, 3 of 3 | None | None |

Why these are grouped:

- **X1:** What a coordinator or side agent may reach, and how its mail is framed. `0120` task 2 is a live check and can run separately.
- **C2:** Same workflow store, and `0100` links to `0080`.
- **C3:** `0110` makes reads cheap. `0370` routes the copies through the same mailbox check.

### Files built on their own

None at the moment. C-0390 (Panel re-render cost) was the last, and is closed (below).

## Status of every finding

51 done, 5 partly done, 11 open, 7 no action.

Batch C9 (Panel split) is closed. Its task-by-task outcomes are in the [closing report](../2026-11-05-c9-closing-report.md).

Batch C-0390 (Panel re-render cost) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `1c2f12837`; its measurement, decision and task-by-task outcome table end the report in the parent of the commit that deleted it. In a component-browser fixture with three conversation groups, 50 unrelated environment, build pipeline or Multi Review writes committed every group's transcript controller 102 times and took 450–590 ms of panel commit time; after the change they commit no controller and take 76–96 ms. No to-do was needed.

Batch C4 (Tool surface) is closed. Its report was analysed against `a2bba9d8` and built from `main` at `7347e5093`; its task-by-task outcome table ends the report in the parent of the commit that deleted it. What it could not prove without real provider turns is in to-do [4920](../../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md).

Batch C5 (Prompt and context) is closed. What it could not prove without real provider turns or real transcripts is in to-dos [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) and [4901](../../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md).

Batch C7 (Work panel and navigation) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C7')"`.
What it left is in to-dos
[4940](../../todo/coordinator-and-multi-review/4940-work-row-answer-and-address.md),
[4941](../../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md),
[4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md) and
[4943](../../todo/coordinator-and-multi-review/4943-launch-override-marker-in-environment-ui.md).

Batch C8 (Tab strip) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C8')"`.
What it left is in to-do
[5200](../../todo/coordinator-and-multi-review/5200-c8-tab-strip-follow-ups.md).

Batch C6 (Errors and dead ends) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C6')"`.
What it left is in to-dos
[4880](../../todo/coordinator-and-multi-review/4880-c6-live-checks.md) and
[4881](../../todo/coordinator-and-multi-review/4881-unavailable-provider-transcript.md).

Batch C10 (Explanations) is closed. It was built from `main` at `a0a6d6206`. Its
task-by-task outcome table ends the last version of its deleted report, which
the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C10')"`.
Every task was done, so it left no to-do.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| S1: `send_message` can write through the project home | Done | Reason and approval gate at `apps/backend/src/core/coordinator-worker-mail.ts:417-432` (`5161688cf`, #1632), which supersedes the report's refusal. |
| S1: reachable through `create_schedule` | Done | The schedule calls the same tool with no reason field: `scheduled-jobs/tools.ts:219-229`, `scheduled-jobs/executor.ts:594-596`. |
| S1: home unmarked in `list_environments` | Open | [X1 part Coordinator 0120](../security/0090-x1-coordinator-trust-boundary.md#coordinator-0120-label-the-project-home-in-listings-and-prove-the-message-gate-live) |
| S1: one helper for every home check | No action | Superseded: the message route is now a designed exception, and `control-mcp-server.ts:603` refuses the others. |
| S1: regression test | Done | `apps/backend/src/core/coordinator-worker-mail.test.ts`, `control-mcp-server-messaging.test.ts`. |
| S1 and 7: live read-only step for mailing the home | Open | [X1 part Coordinator 0120](../security/0090-x1-coordinator-trust-boundary.md#coordinator-0120-label-the-project-home-in-listings-and-prove-the-message-gate-live) |
| S2: side agents can adopt workflows | Open | [X1 part Coordinator 0310](../security/0090-x1-coordinator-trust-boundary.md#coordinator-0310-side-agents-can-call-adopt_workflow) |
| S2: doc drift on side-agent capabilities | Done | `docs/architecture/coordinator.md:351-353` (`3fa7d1733`, #1436). |
| B1: associations never pruned | Done | `storage-coordinators.ts:146-174`, `coordinator-workflow-retention.ts` (`b0dcf1660`, #1620). |
| B1: request aliases kept without limit | Done | Arrival timestamps and expiry, `docs/architecture/coordinator.md:87-90` (`b0dcf1660`). |
| B1: store-full visibility and swallowed delegation open | Open | [C2 part 0080](0080-c2-workflow-records.md#0080-a-full-workflow-store-is-invisible-to-the-user) |
| B1: per-project cap | Open | [C2 part 0080](0080-c2-workflow-records.md#0080-a-full-workflow-store-is-invisible-to-the-user) (the code says shared on purpose, with no reason recorded). |
| B1: list walked long before the cap | Open | [C3 part 0110](0110-c3-sweep-and-reads.md#0110-the-sweep-and-every-snapshot-repeat-global-work) |
| B2: no per-item catch in wake and reconcile loops | Done | `deliverDelegationWakesOnce` and `reconcileWorkerDelegations` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. A wake that keeps failing is retired with one notice (`wakeFailedAt`). |
| B3: delegation closing mid-pass delayed | Done | `runDelegationWakePasses` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| B4: forgotten-node delegations never close | Open | [C2 part 0100](0080-c2-workflow-records.md#0100-delegations-to-a-forgotten-node-never-close) |
| B5: held notices dropped after 24 h | Done | `coordinator-status-backfill.ts`, tested in `coordinator-status-wakes.test.ts`. Whether the remaining rule can go: [4860](../../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md). |
| B6: close during wake delivery | Done | The re-check before `markCoordinatorDelegationWoken` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| B6: waiting cleared only on working | Done | `endWaitingEpisode` in `coordinator-status-wakes.ts`, tested in `coordinator-status-wakes.test.ts` and `coordinator-remote.test.ts`. |
| B7: repair sweep and snapshot cost | Open | [C3 part 0110](0110-c3-sweep-and-reads.md#0110-the-sweep-and-every-snapshot-repeat-global-work) |
| A1: delegation prompt with messaging off | Done | `coordinatorDelegationAvailable` in `coordinator-context-reads.ts`, `withoutWakePromise` in `control-mcp-tools.ts`, the notice in `CoordinatorToolbar.tsx`; tested in `native-agent-service-base.test.ts`, `control-mcp-server-coordinator-workflows.test.ts`, `CoordinatorPanel.test.tsx`. |
| A2: `agent` cannot be omitted | Done | `agent` is optional on `launch_environment` and `launch_job` and resolves to the saved default (`resolveLaunchAgent`, `control-shared-actions.ts`); tested in `control-mcp-server-launch.test.ts`, `control-mcp-operator-tools.test.ts`, `commands-registry-coordinator.test.ts`. A live check that models omit it: [4920](../../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md) task 3. |
| A3: request-id namespace | Done | `COORDINATOR_REQUEST_ID_RULE` in the context and instructions, `COORDINATOR_REQUEST_ID_REUSED_ERROR` on every collision, `replayed: true` on replays, and a pre-send check in `send_message` (`coordinator-worker-mail.ts`); the namespace stays per coordinator, as the report recommended. Tested in `coordinator-worker-mail.test.ts`, `commands-registry-coordinator.test.ts`, `coordinator-review-actions.test.ts`, `coordinator-context.test.ts`. |
| A4: poll-guard coverage | Done | `control-mcp-poll-guard.ts`: semantic keys, a sliding window, and the guard on `list_agents`, `get_environment`, `get_tab_state`, `get_tab_transcript`, `get_build_pipeline`, `get_multi_review` and `list_workflows`; `list_agents` no longer invites polling. Tested in `control-mcp-poll-guard.test.ts`, `control-mcp-server-reads.test.ts`. |
| A5: tool surface and legacy node tools | Partly done | Six legacy node tools and the coordinator's `start_multi_review` removed (`RETIRED_COORDINATOR_TOOLS`, `control-mcp-tools.ts`; `read_node_environment` kept for remote file reads); surface measured and bounded at 82 tools and 115,114 bytes, from 89 and 125,040 (`control-mcp-coordinator-schema-size.test.ts`). Per-provider cost and trimming the field copies of context rules: [4920](../../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md). |
| A5: project name and open delegations in the context | Done | `projectLine` and the `Waiting on` line in `packages/protocol/src/coordinator-context.ts`, read by `readCoordinatorWaitingOn`; tested in `coordinator-context.test.ts`, `coordinator-context-reads.test.ts`. Its cache cost: [4901](../../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md). |
| A6: delegation state for the agent | Done | The `delegation` summary and `openOnly` on `list_workflows` (`control-mcp-coordinator-tools.ts`), and `coordinatorDelegationBucket` shared with the Work panel; tested in `control-mcp-server-coordinator-workflows.test.ts`. |
| A6: cancel a delegation or interrupt a worker turn | Done | `stop_worker_turn`, `control-mcp-coordinator-worker-turns.ts:61` (`fbdea704c`, #1507). |
| A6: worker diff read | Done | `get_worker_changes`, `control-mcp-coordinator-worker-tools.ts:75` (`fbdea704c`, #1507). |
| A7: prompt nudges toward over-delegation | Partly done | [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) (`COORDINATOR_ROUTING_RULE` now offers an idle worker first; softening the read rule waits on a check of real transcripts). |
| A7 note: safety-level reason | Done | The setting sentence comes first, then the platform's caveat: `COORDINATOR_SAFETY_LEVEL_REASON`, `coordinator-providers.ts`, tested in `coordinator-providers.test.ts`. |
| U1: waiting chip with Open buttons | Done | Replaced by the Work panel, `CoordinatorWorkPanel.tsx` (`eb6bf887a`, #1698). |
| U1: Open from mail tiles and the banner | Done | Open on worker notices (`MailTile.tsx`, `workerTabTarget`, `notice.resource.nodeId`) and on the banner (`HumanPromptBanner.tsx`), tested in `MailTile.test.tsx`, `HumanPromptBanner.test.tsx` and `CoordinatorPanel.test.tsx`. |
| U2: confirm closing the main | Done | `CoordinatorPanel.tsx:473-478`, `:569-596` (`e5245dfd6`, #1644). |
| U2: Change agent and main-tab marker | Done | Change agent and the Main label, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPanel.tabs.test.tsx`. The replacement main retains the original group and tab index, including layout edits made while creation is pending. |
| U3: failure replaces the main's transcript | Done | Now a banner, `CoordinatorPanel.tsx:397-412` (`e5245dfd6`, #1644). |
| U3: failure scoped to the conversation | Done | `CoordinatorConversation.startupError` and `coordinatorConversationRunnable` (`packages/protocol/src/coordinator.ts`), with Retry, Close conversation and Copy error in that pane (`CoordinatorStartupFailure`). See `docs/architecture/coordinator.md`, "When a conversation fails to start". Real providers: [4880](../../todo/coordinator-and-multi-review/4880-c6-live-checks.md). |
| U4: Git error masks action errors | Done | Separate lines, `CoordinatorToolbar.tsx:109-111`, `:213-216` (`e5245dfd6`, #1644). |
| U4: collapsed, with no `role="alert"` | Done | `CoordinatorActionAlert`, `CoordinatorPanelNotices.tsx`, tested in `CoordinatorPanel.outcome.test.tsx`. Git's retained error stays a disclosure. |
| U5: Git actions gated on the wrong turn | Done | Any active turn disables them and is named: `useCoordinatorActiveTurn.ts`, `coordinator-checkout-turn.ts`, `CoordinatorToolbar.tsx:94-98`. |
| U6: pausing hides the transcript | Done | Paused panes read saved history and establish nothing: `sendingHeldReason` (`AgentNativeTab.controller.tsx`, `useNativeAgentSession.ts`) and `heldCoordinatorConversation` (`coordinator-runtime.ts`), tested in `native-agent-service-held-coordinator.test.ts`. |
| U7: chip disappears with focus | Done | The Work panel covers every conversation, `docs/architecture/coordinator.md:997-1002` (`eb6bf887a`, #1698). |
| U8: side agents never explained | Done | New side agent's tooltip, and a side composer's own placeholder and hint (`COORDINATOR_SIDE_AGENT_EXPLANATION`, `CoordinatorPanel.tsx`, `CoordinatorConversationPane.tsx`), tested in `CoordinatorPanel.tabs.test.tsx` and `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| U9: dead-end states and scattered settings | Done | Buttons on the provider banner, empty-platform message and no-checkout card, and a Coordinator section in Settings: `CoordinatorConversationPane.tsx`, `CoordinatorPanel.tsx`, `GlobalSettings.sections.tsx`, tested in `CoordinatorPanel.outcome.test.tsx` and `GlobalSettings.coordinator-section.test.tsx`. |
| U10: first sends in two groups | Done | One held prompt per conversation: `useCoordinatorLaunches.ts`. |
| U11: accessibility | Done | Tab semantics, keyboard tab moves and a labelled spinner: `CoordinatorPaneTree.tsx`, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPaneTree.test.tsx` and `CoordinatorPanel.tabs.test.tsx`. The environment strip, deliberately left: [5200](../../todo/coordinator-and-multi-review/5200-c8-tab-strip-follow-ups.md). |
| U12: re-render cost | Done | Measured, then narrowed: `CoordinatorWorkArea.tsx` owns the Work panel's and prompts banner's store subscriptions with the conversations as its children, `useCoordinatorActiveTurn.ts` selects only home environment ids, and `CoordinatorConversationPane.tsx` gives the memoized agent tab stable props; tested in `CoordinatorPanel.render-cost.test.tsx` and `useCoordinatorActiveTurn.test.tsx`. Batch C-0390, below. |
| U13: `Context rN` jargon | Done | Moved into the badge's details (`e5245dfd6`, #1644), a menu since C10 (`CoordinatorIsolationBadge`, `CoordinatorPanelNotices.tsx`). |
| U13: `!` commands | Done | A hint under every coordinator composer, a footer about the coordinator's own work, and the first-message rule shown inline under the composer (`COORDINATOR_COMMAND_HINT`, `FIRST_MESSAGE_COMMAND_RULE` in `AgentNativeTab.helpers.tsx`), tested in `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| U13: leaf-mode gate | Done | `LeafModeCoordinatorGate.tsx` waits for portal status, names "the command node" when no controller is known, and remembers "open anyway" per project for the app session (`openedLeafCoordinators`, `uiStore.ts`); tested in `leaf-mode-coordinator-gate.test.tsx`. Batch C-0410; outcome table in the report's last version before deletion. |
| U13: prompt subscriptions | Partly done | Retention bounds the set. Remote prompts reach the banner (`useRemoteHumanPrompts.ts`, tested with fakes); two real nodes: [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md). |
| U13: picker caveats and tier name | Done | The appended "cannot verify" sentence is gone, and each platform's tier is named in the picker (`platformBadges`, `AgentModelPicker.tsx`), tested in `CoordinatorPanel.test.tsx` and `AgentModelPicker.test.tsx`. Batch C10. |
| U13: tab click writes selection twice | Done | `focusesPane` and `coordinatorDragEndChange` in `CoordinatorPaneTree.tsx`, tested in `CoordinatorPanel.tabs.test.tsx` and `CoordinatorPaneTree.test.tsx`. |
| U13: narrow screens | Done | Icon-only New side agent, Sync and Pause, and a badge showing only its icon and tier name, below `sm` (`CoordinatorPanel.tsx`, `CoordinatorToolbar.tsx`, `CoordinatorPanelNotices.tsx`); the toolbar fits one row at 390 px. |
| U13: research Add limit and Enter | Done | `CoordinatorWebResearchSettings.tsx`, tested in `CoordinatorWebResearchSettings.test.tsx`. |
| U13: research duplicate check is case-sensitive | No action | Names can only be lowercase, `packages/protocol/src/coordinator-web-research.ts:56`. |
| 5.1: Work rail | Partly done | Rail built in `eb6bf887a`, #1698. Request, agent, model, age and Stop added (`CoordinatorWorkPanel.tsx`, `coordinator-work-items.ts`). Answer and Address: [4940](../../todo/coordinator-and-multi-review/4940-work-row-answer-and-address.md); a real abort: [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md); the override marker elsewhere: [4943](../../todo/coordinator-and-multi-review/4943-launch-override-marker-in-environment-ui.md). |
| 5.2: first-run card and starter prompts | Done | Starter prompts in `e5245dfd6` (#1644); the dismissible first-run card and the toolbar's "?" in `CoordinatorIntro.tsx`, dismissed per user in the UI store (`coordinatorIntroDismissed`), tested in `CoordinatorPanel.outcome.test.tsx` and `uiStore.persistence.test.ts`. Batch C10. |
| 5.3: legible read-only tier | Done | A tier pill on the toolbar badge and in the picker; the badge's menu gives the tier's meaning and links Settings → Coordinator (`CoordinatorIsolationBadge`, `CoordinatorPanelNotices.tsx`), tested in `CoordinatorPanel.outcome.test.tsx`. Batch C10. |
| 5.4: error rule and stale indicator | Done | `readFailuresFreshnessNotice` (`view-freshness.ts`) shown by `CoordinatorToolbar.tsx`, tested in `useCoordinatorPanelData.test.tsx`; the rule's other parts came with U3, U4 and U9. |
| 5.5: idle feedback | Partly done | The Work panel, a next-wake line on narrow screens (`CoordinatorNextWakeLine`) and a report cue (`useNotificationSoundService.ts`). A desktop notification: [4941](../../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md). |
| 6: `CoordinatorPanel` does too much | Done | Split from 1,256 to about 600 lines: `CoordinatorToolbar.tsx`, `CoordinatorConversationPane.tsx`, `useCoordinatorSelection.ts`, `useCoordinatorLaunches.ts`, `useCoordinatorGitActions.ts`. |
| 6: repeated action handling and one busy flag | Done | `runAction` with separate Git and conversation flags: `useCoordinatorActions.ts`. |
| 6: delegation decision in three places | Done | `coordinator-delegation-decision.ts`, tested in `coordinator-delegation-decision.test.ts`. The remote goal hold it added needs live proof: [4860](../../todo/coordinator-and-multi-review/4860-c1-wake-reliability-follow-ups.md). |
| 6: reads that write | Open | [C3 part 0110](0110-c3-sweep-and-reads.md#0110-the-sweep-and-every-snapshot-repeat-global-work) |
| 6: partial serialization | Done | `mutateSerialized` in `coordinator-service.ts`, tested in `coordinator-delegation-wakes.test.ts`. |
| 6: copied mailbox check and hand-built runtime ids | Open | [C3 part 0370](0110-c3-sweep-and-reads.md#0370-duplicated-mailbox-authorization-and-runtime-ids-in-the-control-mcp-tools) |
| 6: duplicated request-alias lookup | Open | [C2 part 0380](0080-c2-workflow-records.md#0380-duplicated-request-alias-lookup) |
| 6: context prompt built inline | Done | `buildCoordinatorContext` in `packages/protocol/src/coordinator-context.ts`, tested in `coordinator-context.test.ts`. |
| 1: Top 10 actions | No action | Each restates a finding above. |
| 2: how it works today | No action | A description, not work. |
| 3: strengths worth keeping | No action | Strengths, not work. |
| 7: roadmap | No action | Restates the findings above, apart from the live step listed under S1. |
| 8: notes on this report | No action | Notes only; this split is what section 8 asks for. |
