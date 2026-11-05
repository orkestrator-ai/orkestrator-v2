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
| 1 | [0020-c6-errors-and-dead-ends.md](0020-c6-errors-and-dead-ends.md) | High | No | **C6, Errors and dead ends.**<br>`0020`: Recording a startup failure on the conversation that failed, and showing it in that pane.<br>`0180`: Showing action errors as a visible, announced alert.<br>`0200`: Loading the transcript while paused, and explaining Pause.<br>`0210`: Buttons on state cards, naming the safety level as a reason, and gathering coordinator settings.<br>`0250`: A stale indicator when background reads fail.<br>`0440`: A limit message and Enter to add in web research settings. | From `0020`: Any failed bridge start, even a side agent's, stops MCP, mail and connections for the whole coordinator. |
| 2 | [0040-c4-tool-surface.md](0040-c4-tool-surface.md) | High | No | **C4, Tool surface.**<br>`0040`: Making `agent` optional on `launch_environment` and `launch_job`.<br>`0130`: Wording on new versus reused request ids, and making collisions obvious.<br>`0150`: The `list_agents` wording and a wider, sliding poll guard.<br>`0160`: Removing the legacy node tools and `start_multi_review`, and measuring schema size. | From `0040`: Every launch can silently run on a platform other than the user's default. |
| 3 | [0060-c7-work-panel-and-navigation.md](0060-c7-work-panel-and-navigation.md) | High | No | **C7, Work panel and navigation.**<br>`0060`: Open actions on notice mail tiles and the human-prompt banner.<br>`0260`: The request, agent, model and age on Work rows, plus a Stop action.<br>`0280`: Showing remote workers' waiting prompts in the panel banner.<br>`0450`: A next-wake line and a notification when a report wakes the coordinator. | From `0060`: Users hit these tiles on every delegation and have to find the worker another way. |
| 4 | [0090-x1-coordinator-trust-boundary.md](../security/0090-x1-coordinator-trust-boundary.md) | High | No | **X1, Coordinator trust boundary.**<br>`Security 0090`: M11: delegation scope and marking mail-originated delegations<br>`Security 0180`: L16: operator token reads, confirm token wording, self-reminder framing<br>`Security 0210`: I2: two stale statements about side agents<br>`Coordinator 0120`: Labelling the home in `list_environments` and a live read-only step for the message gate.<br>`Coordinator 0310`: Refusing `adopt_workflow` from a side agent. | From `Security 0090`: An injected worker can reach a user-created environment under its looser policy, limited only by framing and budgets. |
| 5 | [0080-c2-workflow-records.md](0080-c2-workflow-records.md) | Medium | No | **C2, Workflow records.**<br>`0080`: The swallowed delegation-open error, showing store-full to the user, and settling the shared cap.<br>`0100`: Closing work when a node is forgotten, and a notice for a long-offline node.<br>`0380`: One shared alias lookup.: Duplicated request-alias lookup | From `0080`: Retention makes it rare, and what remains is a functional gap when every record is in use. |
| 6 | [0110-c3-sweep-and-reads.md](0110-c3-sweep-and-reads.md) | Medium | No | **C3, Sweep and reads.**<br>`0110`: Syncing once per sweep, a read-only `snapshot()`, batched wake writes and pruning below the limit.<br>`0370`: One own-mailbox check, and `coordinatorRuntimeId` everywhere. | From `0110`: Real repeated work that has not been measured, so it removes a risk rather than a known slowdown. |
| 7 | [0240-c10-explanations.md](0240-c10-explanations.md) | Medium | No | **C10, Explanations.**<br>`0320`: A tooltip, hint and placeholder for side agents.<br>`0330`: A dismissible first-run card.: Explain the coordinator once, in the product<br>`0400`: Discoverability of `!` commands, the footer wording, and a first message starting with `!`.<br>`0240`: Naming the tier in the picker and badge, and removing the repeated caveat. | From `0240`: The badge calls two different tiers advisory, so the user's main safety fact is blurred. |
| 8 | [0390-panel-re-render-cost.md](0390-panel-re-render-cost.md) | Low | No | Narrowing the panel's subscriptions after measuring. | An optimisation that should wait for a measurement. |
| 9 | [0410-leaf-mode-gate-edge-cases.md](0410-leaf-mode-gate-edge-cases.md) | Low | No | The gate's flash before status, an empty controller list, and what "open anyway" remembers. | Edge cases on a rare path. |

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](../batches.md).

Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless **Not at the same time as** names the other one. A batch with no lane only has to respect that column.

This index only changes when a branch merges, so it can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its **Not at the same time as** list. Put the batch ID in the environment and branch name so that check can find it.

### Batches

| Batch | Name | Parts | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| C4 | [Tool surface](0040-c4-tool-surface.md) | `0040`, `0130`, `0150`, `0160` | Coordinator backend, 1 of 4 | None | None |
| X1 | [Coordinator trust boundary](../security/0090-x1-coordinator-trust-boundary.md) | `0120` task 1, `0310`; also security `0090`, `0180`, `0210` | Coordinator backend, 2 of 4 | None | None |
| C2 | [Workflow records](0080-c2-workflow-records.md) | `0080`, `0100`, `0380` | Coordinator backend, 3 of 4 | None | None |
| C3 | [Sweep and reads](0110-c3-sweep-and-reads.md) | `0110`, `0370` | Coordinator backend, 4 of 4 | None | C6 (Errors and dead ends) |
| C7 | [Work panel and navigation](0060-c7-work-panel-and-navigation.md) | `0060`, `0260`, `0280`, `0450` | Coordinator panel, 1 of 4 | None | E23 (Renderer polling) |
| C6 | [Errors and dead ends](0020-c6-errors-and-dead-ends.md) | `0020`, `0180`, `0200`, `0210`, `0250`, `0440` | Coordinator panel, 2 of 4 | None | C3 (Sweep and reads), E12 (Renderer store) |
| C10 | [Explanations](0240-c10-explanations.md) | `0320`, `0330`, `0400`, `0240` | Coordinator panel, 3 of 4 | None | None |

Why these are grouped:

- **C4:** All change what the model sees in the Control MCP tools.
- **X1:** What a coordinator or side agent may reach, and how its mail is framed. `0120` task 2 is a live check and can run separately.
- **C2:** Same workflow store, and `0100` links to `0080`.
- **C3:** `0110` makes reads cheap. `0370` routes the copies through the same mailbox check.
- **C7:** Finding and opening workers. `0060` links to `0260`.
- **C6:** The index splits report section 5.4 across `0020`, `0180`, `0210` and `0250`. Includes backend work: `0020` adds an error to each conversation.
- **C10:** Copy in the notices file. `0320` and `0330` link to each other.

### Files built on their own

These still follow the lane and conflict rules above.

| Batch | Name | Files | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| C-0390 | [Panel re-render cost, measure first](0390-panel-re-render-cost.md) | `0390` | Coordinator panel, 4 of 4 | None | None |
| C-0410 | [Leaf-mode gate](0410-leaf-mode-gate-edge-cases.md) | `0410` | No lane | None | None |

## Status of every finding

33 done, 10 partly done, 24 open, 7 no action.

Batch C9 (Panel split) is closed. Its task-by-task outcomes are in the [closing report](../2026-11-05-c9-closing-report.md).

Batch C5 (Prompt and context) is closed. What it could not prove without real provider turns or real transcripts is in to-dos [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) and [4901](../../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md).

Batch C8 (Tab strip) is closed. Its task-by-task outcome table ends the last
version of its deleted report, which the deletion commit's diff shows in full:
`git show "$(git log -1 --format=%H --grep='close coordinator batch C8')"`.
What it left is in to-do
[5200](../../todo/coordinator-and-multi-review/5200-c8-tab-strip-follow-ups.md).

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
| A2: `agent` cannot be omitted | Open | [C4 part 0040](0040-c4-tool-surface.md#0040-the-launch-agent-cannot-be-omitted-so-defaults-are-not-followed) |
| A3: request-id namespace | Open | [C4 part 0130](0040-c4-tool-surface.md#0130-the-coordinator-is-told-to-reuse-request-ids-but-not-to-make-new-ones) |
| A4: poll-guard coverage | Open | [C4 part 0150](0040-c4-tool-surface.md#0150-poll-guard-coverage-is-uneven) |
| A5: tool surface and legacy node tools | Open | [C4 part 0160](0040-c4-tool-surface.md#0160-trim-the-coordinator-tool-surface-and-remove-the-legacy-node-tools) |
| A5: project name and open delegations in the context | Done | `projectLine` and the `Waiting on` line in `packages/protocol/src/coordinator-context.ts`, read by `readCoordinatorWaitingOn`; tested in `coordinator-context.test.ts`, `coordinator-context-reads.test.ts`. Its cache cost: [4901](../../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md). |
| A6: delegation state for the agent | Done | The `delegation` summary and `openOnly` on `list_workflows` (`control-mcp-coordinator-tools.ts`), and `coordinatorDelegationBucket` shared with the Work panel; tested in `control-mcp-server-coordinator-workflows.test.ts`. |
| A6: cancel a delegation or interrupt a worker turn | Done | `stop_worker_turn`, `control-mcp-coordinator-worker-turns.ts:61` (`fbdea704c`, #1507). |
| A6: worker diff read | Done | `get_worker_changes`, `control-mcp-coordinator-worker-tools.ts:75` (`fbdea704c`, #1507). |
| A7: prompt nudges toward over-delegation | Partly done | [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md) (`COORDINATOR_ROUTING_RULE` now offers an idle worker first; softening the read rule waits on a check of real transcripts). |
| A7 note: safety-level reason | Open | [C6 part 0210](0020-c6-errors-and-dead-ends.md#0210-state-cards-tell-the-user-what-to-do-but-offer-no-way-to-do-it) |
| U1: waiting chip with Open buttons | Done | Replaced by the Work panel, `CoordinatorWorkPanel.tsx` (`eb6bf887a`, #1698). |
| U1: Open from mail tiles and the banner | Open | [C7 part 0060](0060-c7-work-panel-and-navigation.md#0060-open-the-worker-from-mail-tiles-and-the-prompt-banner) |
| U2: confirm closing the main | Done | `CoordinatorPanel.tsx:473-478`, `:569-596` (`e5245dfd6`, #1644). |
| U2: Change agent and main-tab marker | Done | Change agent and the Main label, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPanel.tabs.test.tsx`. The replacement main retains the original group and tab index, including layout edits made while creation is pending. |
| U3: failure replaces the main's transcript | Done | Now a banner, `CoordinatorPanel.tsx:397-412` (`e5245dfd6`, #1644). |
| U3: failure scoped to the conversation | Open | [C6 part 0020](0020-c6-errors-and-dead-ends.md#0020-one-conversations-startup-failure-takes-down-the-whole-coordinator) |
| U4: Git error masks action errors | Done | Separate lines, `CoordinatorToolbar.tsx:109-111`, `:213-216` (`e5245dfd6`, #1644). |
| U4: collapsed, with no `role="alert"` | Open | [C6 part 0180](0020-c6-errors-and-dead-ends.md#0180-coordinator-action-errors-are-still-collapsed-and-silent) |
| U5: Git actions gated on the wrong turn | Done | Any active turn disables them and is named: `useCoordinatorActiveTurn.ts`, `coordinator-checkout-turn.ts`, `CoordinatorToolbar.tsx:94-98`. |
| U6: pausing hides the transcript | Partly done | [C6 part 0200](0020-c6-errors-and-dead-ends.md#0200-paused-conversations-may-not-load-their-transcript) (a banner replaced the card, but connections stay off). |
| U7: chip disappears with focus | Done | The Work panel covers every conversation, `docs/architecture/coordinator.md:997-1002` (`eb6bf887a`, #1698). |
| U8: side agents never explained | Open | [C10 part 0320](0240-c10-explanations.md#0320-side-agents-are-never-explained) |
| U9: dead-end states and scattered settings | Partly done | [C6 part 0210](0020-c6-errors-and-dead-ends.md#0210-state-cards-tell-the-user-what-to-do-but-offer-no-way-to-do-it) (the provider state is now a banner with Retry). |
| U10: first sends in two groups | Done | One held prompt per conversation: `useCoordinatorLaunches.ts`. |
| U11: accessibility | Done | Tab semantics, keyboard tab moves and a labelled spinner: `CoordinatorPaneTree.tsx`, `CoordinatorConversationTab.tsx`, tested in `CoordinatorPaneTree.test.tsx` and `CoordinatorPanel.tabs.test.tsx`. The environment strip, deliberately left: [5200](../../todo/coordinator-and-multi-review/5200-c8-tab-strip-follow-ups.md). |
| U12: re-render cost | Open | [0390-panel-re-render-cost.md](0390-panel-re-render-cost.md) |
| U13: `Context rN` jargon | Done | Moved into the badge's tooltip, `CoordinatorPanelNotices.tsx:75-78` (`e5245dfd6`, #1644). |
| U13: `!` commands | Open | [C10 part 0400](0240-c10-explanations.md#0400--commands-in-the-coordinator-composer-are-undiscoverable) |
| U13: leaf-mode gate | Partly done | [0410-leaf-mode-gate-edge-cases.md](0410-leaf-mode-gate-edge-cases.md) (the "for this session" wording is gone from the button). |
| U13: prompt subscriptions | Partly done | [C7 part 0280](0060-c7-work-panel-and-navigation.md#0280-remote-workers-sign-in-prompts-never-reach-the-banner) (retention bounds the set; remote prompts remain). |
| U13: picker caveats and tier name | Open | [C10 part 0240](0240-c10-explanations.md#0240-make-the-read-only-tier-legible) |
| U13: tab click writes selection twice | Done | `focusesPane` and `coordinatorDragEndChange` in `CoordinatorPaneTree.tsx`, tested in `CoordinatorPanel.tabs.test.tsx` and `CoordinatorPaneTree.test.tsx`. |
| U13: narrow screens | Done | Icon-only New side agent, Sync, Pause and badge below `sm` (`CoordinatorPanel.tsx`, `CoordinatorToolbar.tsx`, `CoordinatorPanelNotices.tsx`); the toolbar fits one row at 390 px. |
| U13: research Add limit and Enter | Open | [C6 part 0440](0020-c6-errors-and-dead-ends.md#0440-web-research-settings-limit-message-and-enter) |
| U13: research duplicate check is case-sensitive | No action | Names can only be lowercase, `packages/protocol/src/coordinator-web-research.ts:56`. |
| 5.1: Work rail | Partly done | [C7 part 0260](0060-c7-work-panel-and-navigation.md#0260-work-panel-rows-lack-the-ask-the-agent-and-quick-actions) (rail built in `eb6bf887a`, #1698). |
| 5.2: first-run card and starter prompts | Partly done | [C10 part 0330](0240-c10-explanations.md#0330-explain-the-coordinator-once-in-the-product) (starter prompts built in `e5245dfd6`, #1644). |
| 5.3: legible read-only tier | Partly done | [C10 part 0240](0240-c10-explanations.md#0240-make-the-read-only-tier-legible) (the badge shows a non-enforced state, under the wrong name). |
| 5.4: error rule and stale indicator | Partly done | [C6 part 0250](0020-c6-errors-and-dead-ends.md#0250-failed-background-reads-leave-the-panel-silently-stale), with the rule's other parts in 0020, 0180 and 0210. |
| 5.5: idle feedback | Partly done | [C7 part 0450](0060-c7-work-panel-and-navigation.md#0450-feedback-while-the-coordinator-is-idle-but-work-runs) (the Work panel covers most of it). |
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
