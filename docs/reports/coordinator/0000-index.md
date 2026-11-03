# Coordinator review: outstanding work

What is left to do from the [coordinator review](../2026-10-27-coordinator.md).

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0010-delegation-wake-loops-stop-on-first-error.md](0010-delegation-wake-loops-stop-on-first-error.md) | High | No | Per-item error handling in the delegation wake and reconcile loops, and retiring a delegation that keeps failing. | One failing delegation stalls report wakes for every project until it is fixed by hand. |
| 2 | [0020-startup-failure-takes-down-whole-coordinator.md](0020-startup-failure-takes-down-whole-coordinator.md) | High | No | Recording a startup failure on the conversation that failed, and showing it in that pane. | Any failed bridge start, even a side agent's, stops MCP, mail and connections for the whole coordinator. |
| 3 | [0030-delegation-offered-with-messaging-off.md](0030-delegation-offered-with-messaging-off.md) | High | No | Gating the delegation prompt and a panel notice on agent messaging. | With a supported setting off, every delegation waits for a wake that cannot arrive. |
| 4 | [0040-launch-agent-cannot-be-omitted.md](0040-launch-agent-cannot-be-omitted.md) | High | No | Making `agent` optional on `launch_environment` and `launch_job`. | Every launch can silently run on a platform other than the user's default. |
| 5 | [0050-wake-during-a-running-pass-waits-for-the-sweep.md](0050-wake-during-a-running-pass-waits-for-the-sweep.md) | High | No | A rerun flag so a delegation closing mid-pass is not left for the next sweep. | Parallel workers are normal use, and a report can wait up to a minute. |
| 6 | [0060-open-worker-from-mail-tiles-and-prompt-banner.md](0060-open-worker-from-mail-tiles-and-prompt-banner.md) | High | No | Open actions on notice mail tiles and the human-prompt banner. | Users hit these tiles on every delegation and have to find the worker another way. |
| 7 | [0070-change-agent-action-and-main-tab-marker.md](0070-change-agent-action-and-main-tab-marker.md) | High | No | A visible Change agent action and a marker on the main tab. | Changing provider is normal use, and the only explanation is an accessible name. |
| 8 | [0080-full-workflow-store-is-invisible.md](0080-full-workflow-store-is-invisible.md) | Medium | No | The swallowed delegation-open error, showing store-full to the user, and settling the shared cap. | Retention makes it rare, and what remains is a functional gap when every record is in use. |
| 9 | [0090-status-backfill-drops-held-notices.md](0090-status-backfill-drops-held-notices.md) | Medium | No | Limiting the 24-hour backfill rule so held status notices are not dropped. | A functional gap that needs a main closed for over a day with non-terminal work settled. |
| 10 | [0100-forgotten-node-delegations-never-close.md](0100-forgotten-node-delegations-never-close.md) | Medium | No | Closing work when a node is forgotten, and a notice for a long-offline node. | A functional gap for multi-node users only, and these records also hold store slots for good. |
| 11 | [0110-sweep-and-snapshot-repeat-global-work.md](0110-sweep-and-snapshot-repeat-global-work.md) | Medium | No | Syncing once per sweep, a read-only `snapshot()`, batched wake writes and pruning below the limit. | Real repeated work that has not been measured, so it removes a risk rather than a known slowdown. |
| 12 | [0120-project-home-listing-and-live-check.md](0120-project-home-listing-and-live-check.md) | Medium | No | Labelling the home in `list_environments` and a live read-only step for the message gate. | The gate is built with unit evidence, so what remains is a label and a qualification run. |
| 13 | [0130-request-id-namespace-is-not-explained.md](0130-request-id-namespace-is-not-explained.md) | Medium | No | Wording on new versus reused request ids, and making collisions obvious. | A collision can replay old work or lose a wake, but needs a model to reuse an id. |
| 14 | [0140-coordinator-cannot-read-delegation-state.md](0140-coordinator-cannot-read-delegation-state.md) | Medium | No | Exposing delegation state to the coordinator. | A functional gap that forces polling, with a slower workaround through other reads. |
| 15 | [0150-poll-guard-coverage.md](0150-poll-guard-coverage.md) | Medium | No | The `list_agents` wording and a wider, sliding poll guard. | A gap that lets a polling coordinator waste turns unseen, with no evidence of how often. |
| 16 | [0160-tool-surface-and-legacy-node-tools.md](0160-tool-surface-and-legacy-node-tools.md) | Medium | No | Removing the legacy node tools and `start_multi_review`, and measuring schema size. | Duplicates carry a real behaviour risk, and the per-turn cost is a missing measurement. |
| 17 | [0170-context-block-project-name-and-open-work.md](0170-context-block-project-name-and-open-work.md) | Medium | No | The project name and a one-line open-work summary in the context block. | A functional gap that matters most after context compaction. |
| 18 | [0180-coordinator-errors-need-an-alert.md](0180-coordinator-errors-need-an-alert.md) | Medium | No | Showing action errors as a visible, announced alert. | The masking is fixed, and what remains is a collapsed error with no announcement. |
| 19 | [0190-branch-switch-gated-on-the-wrong-turn.md](0190-branch-switch-gated-on-the-wrong-turn.md) | Medium | No | Gating branch switch and Sync on any active turn. | A late refusal, seen only with a side agent focused while another turn runs. |
| 20 | [0200-paused-and-errored-conversations-do-not-connect.md](0200-paused-and-errored-conversations-do-not-connect.md) | Medium | No | Loading the transcript while paused, and explaining Pause. | A possible empty pane after reload while paused, read from code but not yet seen. |
| 21 | [0210-state-cards-end-in-dead-ends.md](0210-state-cards-end-in-dead-ends.md) | Medium | No | Buttons on state cards, naming the safety level as a reason, and gathering coordinator settings. | A functional gap in uncommon states, with a workaround through Settings. |
| 22 | [0220-first-sends-in-two-groups-drop-a-prompt.md](0220-first-sends-in-two-groups-drop-a-prompt.md) | Medium | No | Keying pending first launches by conversation. | It loses a prompt, but only with two first sends within moments. |
| 23 | [0230-tab-strip-accessibility.md](0230-tab-strip-accessibility.md) | Medium | No | Tab semantics, keyboard tab moves and a labelled spinner. | A functional gap for keyboard and screen reader users. |
| 24 | [0240-read-only-tier-is-not-legible.md](0240-read-only-tier-is-not-legible.md) | Medium | No | Naming the tier in the picker and badge, and removing the repeated caveat. | The badge calls two different tiers advisory, so the user's main safety fact is blurred. |
| 25 | [0250-panel-reads-fail-silently.md](0250-panel-reads-fail-silently.md) | Medium | No | A stale indicator when background reads fail. | A functional gap that shows out-of-date state only after a failed read. |
| 26 | [0260-work-panel-row-detail-and-actions.md](0260-work-panel-row-detail-and-actions.md) | Medium | No | The request, agent, model and age on Work rows, plus a Stop action. | The rail is built, and this is a gap in what it shows. |
| 27 | [0270-delegation-decision-spread-over-three-places.md](0270-delegation-decision-spread-over-three-places.md) | Medium | No | One pure function for deciding whether a delegation is finished. | A refactor that removes a real risk of the three paths drifting further. |
| 28 | [0280-remote-worker-prompts-miss-the-banner.md](0280-remote-worker-prompts-miss-the-banner.md) | Medium | No | Showing remote workers' waiting prompts in the panel banner. | A parity gap between local and remote workers. |
| 29 | [0290-close-select-and-pause-are-not-serialized.md](0290-close-select-and-pause-are-not-serialized.md) | Low | No | Serializing close, select and pause, with a check before marking a wake done. | A narrow race that the report did not reproduce and that has a recovery path. |
| 30 | [0300-waiting-episode-cleared-only-on-working.md](0300-waiting-episode-cleared-only-on-working.md) | Low | No | Clearing the waiting marker on any edge that leaves waiting. | An edge case needing a waiting-to-idle change on a delegation that stays open. |
| 31 | [0310-side-agents-can-call-adopt-workflow.md](0310-side-agents-can-call-adopt-workflow.md) | Low | No | Refusing `adopt_workflow` from a side agent. | Wakes still reach the main and live work moves back, so the effect is small. |
| 32 | [0320-side-agents-are-never-explained.md](0320-side-agents-are-never-explained.md) | Low | No | A tooltip, hint and placeholder for side agents. | Explanatory copy for an optional feature. |
| 33 | [0330-first-run-explanation-of-the-coordinator.md](0330-first-run-explanation-of-the-coordinator.md) | Low | No | A dismissible first-run card.: Explain the coordinator once, in the product | Optional onboarding, with nothing broken without it. |
| 34 | [0340-coordinator-panel-does-too-much.md](0340-coordinator-panel-does-too-much.md) | Low | No | Splitting `CoordinatorPanel.tsx`. | Maintainability only, best done alongside other changes. |
| 35 | [0350-one-busy-flag-for-unrelated-actions.md](0350-one-busy-flag-for-unrelated-actions.md) | Low | No | A `runAction` helper and separate busy flags. | A brief, harmless block on unrelated controls. |
| 36 | [0360-coordinator-context-built-inline.md](0360-coordinator-context-built-inline.md) | Low | No | A pure builder for the context prompt. | A refactor for testability with no user-visible effect. |
| 37 | [0370-duplicated-mailbox-authorization-and-runtime-ids.md](0370-duplicated-mailbox-authorization-and-runtime-ids.md) | Low | No | One own-mailbox check, and `coordinatorRuntimeId` everywhere. | Duplicated code that behaves the same today. |
| 38 | [0380-duplicated-request-alias-lookup.md](0380-duplicated-request-alias-lookup.md) | Low | No | One shared alias lookup.: Duplicated request-alias lookup | A small duplication with no current divergence. |
| 39 | [0390-panel-re-render-cost.md](0390-panel-re-render-cost.md) | Low | No | Narrowing the panel's subscriptions after measuring. | An optimisation that should wait for a measurement. |
| 40 | [0400-user-commands-in-the-coordinator-composer.md](0400-user-commands-in-the-coordinator-composer.md) | Low | No | Discoverability of `!` commands, the footer wording, and a first message starting with `!`. | Cosmetic wording on an optional feature. |
| 41 | [0410-leaf-mode-gate-edge-cases.md](0410-leaf-mode-gate-edge-cases.md) | Low | No | The gate's flash before status, an empty controller list, and what "open anyway" remembers. | Edge cases on a rare path. |
| 42 | [0420-tab-click-writes-selection-twice.md](0420-tab-click-writes-selection-twice.md) | Low | No | One selection write per tab click. | Two writes with a brief wrong selection, and no lasting effect. |
| 43 | [0430-toolbar-on-narrow-screens.md](0430-toolbar-on-narrow-screens.md) | Low | No | Collapsing the New side agent label on narrow screens. | A cosmetic fix. |
| 44 | [0440-web-research-settings-polish.md](0440-web-research-settings-polish.md) | Low | No | A limit message and Enter to add in web research settings. | A cosmetic fix in a rarely used form. |
| 45 | [0450-feedback-while-the-coordinator-is-idle.md](0450-feedback-while-the-coordinator-is-idle.md) | Low | No | A next-wake line and a notification when a report wakes the coordinator. | An optional extra now that the Work panel shows running work. |
| 46 | [0460-prompt-nudges-toward-over-delegation.md](0460-prompt-nudges-toward-over-delegation.md) | Low | No | Prompt wording that prefers an idle existing worker and softens the read rule. | Plausible only, since nothing shows that it happens in practice. |

## Status of every finding

14 done, 10 partly done, 43 open, 7 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| S1: `send_message` can write through the project home | Done | Reason and approval gate at `apps/backend/src/core/coordinator-worker-mail.ts:417-432` (`5161688cf`, #1632), which supersedes the report's refusal. |
| S1: reachable through `create_schedule` | Done | The schedule calls the same tool with no reason field: `scheduled-jobs/tools.ts:219-229`, `scheduled-jobs/executor.ts:594-596`. |
| S1: home unmarked in `list_environments` | Open | [0120-project-home-listing-and-live-check.md](0120-project-home-listing-and-live-check.md) |
| S1: one helper for every home check | No action | Superseded: the message route is now a designed exception, and `control-mcp-server.ts:603` refuses the others. |
| S1: regression test | Done | `apps/backend/src/core/coordinator-worker-mail.test.ts`, `control-mcp-server-messaging.test.ts`. |
| S1 and 7: live read-only step for mailing the home | Open | [0120-project-home-listing-and-live-check.md](0120-project-home-listing-and-live-check.md) |
| S2: side agents can adopt workflows | Open | [0310-side-agents-can-call-adopt-workflow.md](0310-side-agents-can-call-adopt-workflow.md) |
| S2: doc drift on side-agent capabilities | Done | `docs/architecture/coordinator.md:351-353` (`3fa7d1733`, #1436). |
| B1: associations never pruned | Done | `storage-coordinators.ts:146-174`, `coordinator-workflow-retention.ts` (`b0dcf1660`, #1620). |
| B1: request aliases kept without limit | Done | Arrival timestamps and expiry, `docs/architecture/coordinator.md:87-90` (`b0dcf1660`). |
| B1: store-full visibility and swallowed delegation open | Open | [0080-full-workflow-store-is-invisible.md](0080-full-workflow-store-is-invisible.md) |
| B1: per-project cap | Open | [0080-full-workflow-store-is-invisible.md](0080-full-workflow-store-is-invisible.md) (the code says shared on purpose, with no reason recorded). |
| B1: list walked long before the cap | Open | [0110-sweep-and-snapshot-repeat-global-work.md](0110-sweep-and-snapshot-repeat-global-work.md) |
| B2: no per-item catch in wake and reconcile loops | Open | [0010-delegation-wake-loops-stop-on-first-error.md](0010-delegation-wake-loops-stop-on-first-error.md) |
| B3: delegation closing mid-pass delayed | Open | [0050-wake-during-a-running-pass-waits-for-the-sweep.md](0050-wake-during-a-running-pass-waits-for-the-sweep.md) |
| B4: forgotten-node delegations never close | Open | [0100-forgotten-node-delegations-never-close.md](0100-forgotten-node-delegations-never-close.md) |
| B5: held notices dropped after 24 h | Open | [0090-status-backfill-drops-held-notices.md](0090-status-backfill-drops-held-notices.md) |
| B6: close during wake delivery | Open | [0290-close-select-and-pause-are-not-serialized.md](0290-close-select-and-pause-are-not-serialized.md) |
| B6: waiting cleared only on working | Open | [0300-waiting-episode-cleared-only-on-working.md](0300-waiting-episode-cleared-only-on-working.md) |
| B7: repair sweep and snapshot cost | Open | [0110-sweep-and-snapshot-repeat-global-work.md](0110-sweep-and-snapshot-repeat-global-work.md) |
| A1: delegation prompt with messaging off | Open | [0030-delegation-offered-with-messaging-off.md](0030-delegation-offered-with-messaging-off.md) |
| A2: `agent` cannot be omitted | Open | [0040-launch-agent-cannot-be-omitted.md](0040-launch-agent-cannot-be-omitted.md) |
| A3: request-id namespace | Open | [0130-request-id-namespace-is-not-explained.md](0130-request-id-namespace-is-not-explained.md) |
| A4: poll-guard coverage | Open | [0150-poll-guard-coverage.md](0150-poll-guard-coverage.md) |
| A5: tool surface and legacy node tools | Open | [0160-tool-surface-and-legacy-node-tools.md](0160-tool-surface-and-legacy-node-tools.md) |
| A5: project name and open delegations in the context | Open | [0170-context-block-project-name-and-open-work.md](0170-context-block-project-name-and-open-work.md) |
| A6: delegation state for the agent | Open | [0140-coordinator-cannot-read-delegation-state.md](0140-coordinator-cannot-read-delegation-state.md) |
| A6: cancel a delegation or interrupt a worker turn | Done | `stop_worker_turn`, `control-mcp-coordinator-worker-turns.ts:61` (`fbdea704c`, #1507). |
| A6: worker diff read | Done | `get_worker_changes`, `control-mcp-coordinator-worker-tools.ts:75` (`fbdea704c`, #1507). |
| A7: prompt nudges toward over-delegation | Open | [0460-prompt-nudges-toward-over-delegation.md](0460-prompt-nudges-toward-over-delegation.md) |
| A7 note: safety-level reason | Open | [0210-state-cards-end-in-dead-ends.md](0210-state-cards-end-in-dead-ends.md) |
| U1: waiting chip with Open buttons | Done | Replaced by the Work panel, `CoordinatorWorkPanel.tsx` (`eb6bf887a`, #1698). |
| U1: Open from mail tiles and the banner | Open | [0060-open-worker-from-mail-tiles-and-prompt-banner.md](0060-open-worker-from-mail-tiles-and-prompt-banner.md) |
| U2: confirm closing the main | Done | `CoordinatorPanel.tsx:1083-1087`, `:1196-1223` (`e5245dfd6`, #1644). |
| U2: Change agent and main-tab marker | Open | [0070-change-agent-action-and-main-tab-marker.md](0070-change-agent-action-and-main-tab-marker.md) |
| U3: failure replaces the main's transcript | Done | Now a banner, `CoordinatorPanel.tsx:1007-1022` (`e5245dfd6`, #1644). |
| U3: failure scoped to the conversation | Open | [0020-startup-failure-takes-down-whole-coordinator.md](0020-startup-failure-takes-down-whole-coordinator.md) |
| U4: Git error masks action errors | Done | Separate lines, `CoordinatorPanel.tsx:866-868`, `:992-997` (`e5245dfd6`, #1644). |
| U4: collapsed, with no `role="alert"` | Open | [0180-coordinator-errors-need-an-alert.md](0180-coordinator-errors-need-an-alert.md) |
| U5: Git actions gated on the wrong turn | Open | [0190-branch-switch-gated-on-the-wrong-turn.md](0190-branch-switch-gated-on-the-wrong-turn.md) |
| U6: pausing hides the transcript | Partly done | [0200-paused-and-errored-conversations-do-not-connect.md](0200-paused-and-errored-conversations-do-not-connect.md) (a banner replaced the card, but connections stay off). |
| U7: chip disappears with focus | Done | The Work panel covers every conversation, `docs/architecture/coordinator.md:997-1002` (`eb6bf887a`, #1698). |
| U8: side agents never explained | Open | [0320-side-agents-are-never-explained.md](0320-side-agents-are-never-explained.md) |
| U9: dead-end states and scattered settings | Partly done | [0210-state-cards-end-in-dead-ends.md](0210-state-cards-end-in-dead-ends.md) (the provider state is now a banner with Retry). |
| U10: first sends in two groups | Open | [0220-first-sends-in-two-groups-drop-a-prompt.md](0220-first-sends-in-two-groups-drop-a-prompt.md) |
| U11: accessibility | Open | [0230-tab-strip-accessibility.md](0230-tab-strip-accessibility.md) |
| U12: re-render cost | Open | [0390-panel-re-render-cost.md](0390-panel-re-render-cost.md) |
| U13: `Context rN` jargon | Done | Moved into the badge's tooltip, `CoordinatorPanelNotices.tsx:75-78` (`e5245dfd6`, #1644). |
| U13: `!` commands | Open | [0400-user-commands-in-the-coordinator-composer.md](0400-user-commands-in-the-coordinator-composer.md) |
| U13: leaf-mode gate | Partly done | [0410-leaf-mode-gate-edge-cases.md](0410-leaf-mode-gate-edge-cases.md) (the "for this session" wording is gone from the button). |
| U13: prompt subscriptions | Partly done | [0280-remote-worker-prompts-miss-the-banner.md](0280-remote-worker-prompts-miss-the-banner.md) (retention bounds the set; remote prompts remain). |
| U13: picker caveats and tier name | Open | [0240-read-only-tier-is-not-legible.md](0240-read-only-tier-is-not-legible.md) |
| U13: tab click writes selection twice | Open | [0420-tab-click-writes-selection-twice.md](0420-tab-click-writes-selection-twice.md) |
| U13: narrow screens | Open | [0430-toolbar-on-narrow-screens.md](0430-toolbar-on-narrow-screens.md) |
| U13: research Add limit and Enter | Open | [0440-web-research-settings-polish.md](0440-web-research-settings-polish.md) |
| U13: research duplicate check is case-sensitive | No action | Names can only be lowercase, `packages/protocol/src/coordinator-web-research.ts:56`. |
| 5.1: Work rail | Partly done | [0260-work-panel-row-detail-and-actions.md](0260-work-panel-row-detail-and-actions.md) (rail built in `eb6bf887a`, #1698). |
| 5.2: first-run card and starter prompts | Partly done | [0330-first-run-explanation-of-the-coordinator.md](0330-first-run-explanation-of-the-coordinator.md) (starter prompts built in `e5245dfd6`, #1644). |
| 5.3: legible read-only tier | Partly done | [0240-read-only-tier-is-not-legible.md](0240-read-only-tier-is-not-legible.md) (the badge shows a non-enforced state, under the wrong name). |
| 5.4: error rule and stale indicator | Partly done | [0250-panel-reads-fail-silently.md](0250-panel-reads-fail-silently.md), with the rule's other parts in 0020, 0180 and 0210. |
| 5.5: idle feedback | Partly done | [0450-feedback-while-the-coordinator-is-idle.md](0450-feedback-while-the-coordinator-is-idle.md) (the Work panel covers most of it). |
| 6: `CoordinatorPanel` does too much | Partly done | [0340-coordinator-panel-does-too-much.md](0340-coordinator-panel-does-too-much.md) (notices and the Work panel moved out). |
| 6: repeated action handling and one busy flag | Open | [0350-one-busy-flag-for-unrelated-actions.md](0350-one-busy-flag-for-unrelated-actions.md) |
| 6: delegation decision in three places | Open | [0270-delegation-decision-spread-over-three-places.md](0270-delegation-decision-spread-over-three-places.md) |
| 6: reads that write | Open | [0110-sweep-and-snapshot-repeat-global-work.md](0110-sweep-and-snapshot-repeat-global-work.md) |
| 6: partial serialization | Open | [0290-close-select-and-pause-are-not-serialized.md](0290-close-select-and-pause-are-not-serialized.md) |
| 6: copied mailbox check and hand-built runtime ids | Open | [0370-duplicated-mailbox-authorization-and-runtime-ids.md](0370-duplicated-mailbox-authorization-and-runtime-ids.md) |
| 6: duplicated request-alias lookup | Open | [0380-duplicated-request-alias-lookup.md](0380-duplicated-request-alias-lookup.md) |
| 6: context prompt built inline | Open | [0360-coordinator-context-built-inline.md](0360-coordinator-context-built-inline.md) |
| 1: Top 10 actions | No action | Each restates a finding above. |
| 2: how it works today | No action | A description, not work. |
| 3: strengths worth keeping | No action | Strengths, not work. |
| 7: roadmap | No action | Restates the findings above, apart from the live step listed under S1. |
| 8: notes on this report | No action | Notes only; this split is what section 8 asks for. |
