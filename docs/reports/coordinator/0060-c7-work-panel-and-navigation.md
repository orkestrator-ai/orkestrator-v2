# C7: Work panel and navigation

This file combines 4 reports into one batch to build together. Finding and opening workers. `0060` links to `0260`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0060](#0060-open-the-worker-from-mail-tiles-and-the-prompt-banner) | High | Open actions on notice mail tiles and the human-prompt banner. |
| [0260](#0260-work-panel-rows-lack-the-ask-the-agent-and-quick-actions) | Medium | The request, agent, model and age on Work rows, plus a Stop action. |
| [0280](#0280-remote-workers-sign-in-prompts-never-reach-the-banner) | Medium | Showing remote workers' waiting prompts in the panel banner. |
| [0450](#0450-feedback-while-the-coordinator-is-idle-but-work-runs) | Low | A next-wake line and a notification when a report wakes the coordinator. |

## 0060: Open the worker from mail tiles and the prompt banner

### Task analysis

#### Tasks

1. **Add Open to notice tiles**: a mail tile whose notice names a worker gets an Open action. Status: open.
2. **Add Open to the prompt banner**: a worker's waiting prompt links to its tab. Status: open.

#### 1. Add Open to notice tiles

**Problem.** A tile saying a worker finished, failed or needs the user offers only the mail thread. The user has to find the worker elsewhere.

**Context.** The other half of this finding is done: the Work panel replaced the chip and every row has an Open button (see [Current state](#current-state)).

**Investigation.** `MailTile.tsx:275-285` renders only "Open conversation". The delegation wake already carries `notice.resource` with `environmentId` and `tabId` (`coordinator-service.ts:1319-1326`), as does the human-prompt notice (`:1430-1436`). `openCoordinatorWorkTarget` (`apps/web/src/lib/coordinator-work-navigation.ts`) handles a `worker-tab` target. `MailTile` also renders outside coordinator chats.

**Decisions.**

- **Which navigation does the tile use?**
  - **`openCoordinatorWorkTarget` with a `worker-tab` target, only when the notice has an `agent-tab` resource (recommended).**
    - Pros: one navigation path with the Work panel; the tile says nothing it cannot act on.
    - Cons: a notice from another node names a local-looking id; `notice.resource` has no `nodeId`, so a remote worker needs that added or no button.
  - **Only link the name inside the sender text.**
    - Pros: no new control.
    - Cons: the tile's header is already a button, and nesting a link in it is invalid.

#### 2. Add Open to the prompt banner

**Problem.** The banner tells the user to answer "in the worker's tab" and gives no way to get there.

**Context.** The banner is shared with ordinary tabs, where the prompt is already in front of the user.

**Investigation.** `HumanPromptBanner.tsx:53` has the text. `CoordinatorPanel.tsx:1043-1049` passes it `workerPrompts` with a `label` prop, and each entry has `environmentId` and `tabId`.

**Decisions.** None: add an optional `onOpen(entry)` prop that the coordinator panel supplies, leaving other callers unchanged.

### Current state

- `eb6bf887a` (#1698) replaced the "Waiting on N workers" chip with the Work panel (`CoordinatorWorkPanel.tsx`), with sections for needs-you, running and finished, and an Open button per row. Open on a row with a question goes to that tab; there is no separate Answer button.

## 0260: Work panel rows lack the ask, the agent and quick actions

### Task analysis

#### Tasks

1. **Show what was asked, on what, and since when**: a worker row adds its request, agent and model, and elapsed time. Status: open.
2. **Add row actions beyond Open**: Stop, Answer and Address where they apply. Status: open.

#### 1. Show what was asked, on what, and since when

**Problem.** The rail shows name, machine and stage. The report's table also has the prompt, agent and model, and age. Without them the user still has to open each worker to learn what it is doing, and a launch that overrode the default is not visible.

**Context.** `docs/architecture/coordinator.md:2136-2137` says the missing override marker "is a tracked follow-up", but no todo file mentions it.

**Investigation.** `WorkRow` renders name, machine, stage and criteria (`CoordinatorWorkPanel.tsx:60-117`). The report says delegations hold a `selection`, but they do not: `CoordinatorDelegation` (`packages/protocol/src/coordinator.ts:264-296`) has none. `selection` is only in tool results (`coordinator.md:2128-2136`). The association has no prompt text either. The worker's `initialPromptPresentation` frame sits on the environment (`commands-registry-coordinator.ts:495-501`), and only for a launch.

**Decisions.**

- **Where does a request summary come from?**
  - **Persist a short bounded `summary` and the selection on the delegation when it opens (recommended).**
    - Pros: covers launches, jobs, prompts and messages alike; works for remote workers from the local record.
    - Cons: prompt text enters the coordinator store, which is rewritten whole, so it must be small; older records have none.
  - **Read each worker's first message from its transcript.**
    - Pros: nothing stored.
    - Cons: one read per row, unavailable for an offline node.

#### 2. Add row actions beyond Open

**Problem.** Stopping a worker or addressing a review takes two steps through its own view.

**Context.** Open already lands on the right tab, so this is a convenience.

**Investigation.** Each row has one button (`CoordinatorWorkPanel.tsx:103-116`). The commands exist behind their own screens.

**Decisions.**

- **Build it now?**
  - **Only Stop, after use shows the need (recommended).**
    - Pros: the one action where a detour matters; the others want their own context.
    - Cons: the rail stays read-mostly.
  - **All three.**
    - Pros: the report's whole table.
    - Cons: Answer and Address duplicate surfaces that show more, in a narrow rail.

### Current state

- `eb6bf887a` (#1698) built the rail itself and the sections, stages, expiry and remote reads described in `docs/architecture/coordinator.md:989-1073`.

## 0280: Remote workers' sign-in prompts never reach the banner

### Task analysis

#### Tasks

1. **Show remote workers' prompts**: the panel's prompt banner covers workers on other nodes. Status: open.

#### 1. Show remote workers' prompts

**Problem.** A worker on another node waiting on a sign-in link or code does not appear in the panel's banner. The person talking to the coordinator has to find it another way.

**Context.** The other half of this report item, the growing subscription set, is largely gone (see [Current state](#current-state-2)).

**Investigation.** `workerEnvironmentIds` excludes any association with a `nodeId` (`CoordinatorPanel.tsx:532-548`), and `useHumanPrompts` reads the local backend only (`apps/web/src/hooks/useUserCommands.ts:79-104`). The notice to the coordinator is also local: `noteWorkerHumanPrompt` filters out `nodeId` (`coordinator-service.ts:1367-1375`). The Work panel can show a remote worker's waiting state (`docs/architecture/coordinator.md:1025-1026`), but not the prompt itself.

**Decisions.**

- **How does the prompt cross?**
  - **Read `listHumanPrompts` through `invokeOnNode` per node, refreshed with node summaries, as the Work panel's remote reads do (recommended).**
    - Pros: no new protocol; the same freshness as other remote rows.
    - Cons: a sign-in link crossing nodes needs a check against what node summaries deliberately omit, and the delay is that of a summary refresh.
  - **Send the prompt as a status notice from the leaf.**
    - Pros: the coordinator hears it too.
    - Cons: new cross-node mail kinds, and it does not reach the banner by itself.

### Current state

- Retention now drops old finished records, so the set of environment ids no longer grows without limit (`b0dcf1660`, #1620). It still includes every kept association, including finished ones (`CoordinatorPanel.tsx:532-546`), which is harmless given the read is one list call.

### Needs verification

Whether a remote worker's prompt reaches the user by any other route in practice; needs two nodes.

## 0450: Feedback while the coordinator is idle but work runs

### Task analysis

#### Tasks

1. **Say what the next wake waits for**: a live line under the last message. Status: open.
2. **Notify when a coordinator wakes with a report**: an optional desktop notification. Status: open.

#### 1. Say what the next wake waits for

**Problem.** An idle chat with workers running can still look stuck if the user is looking at the conversation rather than at the rail.

**Context.** The Work panel closed most of this gap (see [Current state](#current-state-3)).

**Investigation.** `data-open-delegations` and `counts` are available in `useCoordinatorWorkItems`; nothing is rendered in the conversation. On narrow screens the panel is only a strip.

**Decisions.**

- **Is the line still worth building?**
  - **Only on narrow screens, or not at all, after using the panel for a while (recommended).**
    - Pros: avoids restating what the rail already says, at the cost of no agent turns either way.
    - Cons: the wide-screen conversation stays quiet.
  - **Always show "Next wake when api-fix finishes".**
    - Pros: as the report proposes.
    - Cons: a second live list; more than one running worker makes it long.

#### 2. Notify when a coordinator wakes with a report

**Problem.** A user who leaves the page has no prompt to come back.

**Context.** The report says desktop notifications already exist for human prompts. They do not: the only ones in the code are for a dialog needing attention (`apps/desktop/electron/dialog-attention.ts:18`) and a remote restart (`apps/desktop/electron/main.ts:829`), and `apps/web/src` creates none. The app does have notification sounds (`useNotificationSoundService.ts`).

**Investigation.** A mail wake passes through `dispatchMailInject` (`docs/architecture/coordinator.md:945-948`). A notification would be new for this surface, and would need a web answer too.

**Decisions.**

- **Sound or notification?**
  - **Extend the existing sound service first (recommended).**
    - Pros: exists on every client, with its own settings.
    - Cons: no text, and it needs the app running with sound on.
  - **Build a desktop notification.**
    - Pros: says which worker reported.
    - Cons: new permission handling, and nothing on the web client; a wider feature than this finding.

### Current state

- `eb6bf887a` (#1698): the Work panel shows running work and moves while the coordinator is idle, at no agent cost.

## Related

- [Coordinator report, 4.4 (U1)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 5.1](../2026-10-27-coordinator.md#51-make-delegated-work-a-first-class-visible-object)
- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0395-coordinator-worker-surfaces-follow-ups.md](../../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md)
- [Coordinator report, 5.5](../2026-10-27-coordinator.md#55-feedback-while-the-coordinator-is-idle-but-work-is-running)

## Part 0280 security check

Result: showing a sign-in link or code across nodes does not widen what a remote read exposes, so the banner shows them.

- **What summaries omit, and why it does not apply.** `node-summaries.ts` carries "names, status and activity only, never transcripts, prompts, paths or credentials". Those summaries go to every client and the command node keeps them as last-known state. This read does neither: the answer stays in the panel's React state, and `NodePortal.invokeOnNode` and `routeToNode` log no arguments or results.
- **What `invokeOnNode` already permits.** `list_human_prompts` is in neither `NODE_EXCLUDED_COMMANDS` nor `isWorkspaceExcludedCommand`. A window opened on that node already draws the same banner, and `get_native_agent_projection` crosses the same link carrying the tool output the prompt was detected in.
- **What was added because a remote answer is untrusted.** A link must pass `isSignInLink`, every field is bounded, `userCommandId` is dropped, and entries for environments not asked for are refused.

## Outcome

Checked item by item against this file on 2026-11-05. Base commit `af2e566e5`. The line numbers above had moved, but every finding still held, so none closes as "no longer holds". Rechecked against the review repairs in `c5febd59f`: every name below still exists.

| Part | Task | Outcome | Where |
| --- | --- | --- | --- |
| 0060 | 1. Add Open to notice tiles | Done | `useNoticeWorkerTarget` and the Open button in `MailTile.tsx`, through `openCoordinatorWorkTarget` and `workerTabTarget`; `notice.resource.nodeId` added (`agent-mail.ts`, `coordinator-service.ts`, `coordinator-status-wakes.ts`, `storage-agent-mail-budgets.ts`). Tested in `MailTile.test.tsx` (opens, and no action when unreachable), `coordinator-work-items.test.ts`, `agent-mail.test.ts`, `coordinator-remote.test.ts`. |
| 0060 | 2. Add Open to the prompt banner | Done | Optional `onOpen` and `canOpen` on `HumanPromptBanner.tsx`, supplied by `CoordinatorPanel.tsx`; `AgentNativeTab.controller.tsx` passes neither and is unchanged. Tested in `HumanPromptBanner.test.tsx` and `CoordinatorPanel.test.tsx`; seen on an isolated profile opening the worker's tab. |
| 0260 | 1. Show what was asked, on what, and since when | Done | `CoordinatorDelegation.request`, bounded by `normalizeCoordinatorDelegationRequest` in `coordinator.ts` and at `openCoordinatorDelegation`; recorded by launches, jobs, prompts, mail, forks, goals and commands (`coordinator-delegation-request.ts`, `control-mcp-tools.ts`, `coordinator-worker-mail.ts`, `commands-registry-coordinator-nodes.ts`); drawn by `WorkRow` from `workerItem` and `workAge`. Tested in `coordinator.test.ts`, `coordinator-worker-turns.test.ts`, `coordinator-work-items.test.ts`, `CoordinatorWorkPanel.test.tsx`, including records without the fields. |
| 0260 | 1. The missing override marker ("tracked follow-up") | Done on Work rows; moved to to-do [4943](../../todo/coordinator-and-multi-review/4943-launch-override-marker-in-environment-ui.md) for the environment and tab UI | "requested" on `WorkRow`, from `request.source`. |
| 0260 | 2. Add row actions: Stop | Done; a real abort moved to to-do [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md) task 2 | `stopCoordinatorWorkerTurn` calling `stop_coordinator_worker_turn` with `stoppedBy: "user"`, `stopRequestedBy` in `coordinator-worker-turn-actions.ts`, the wake's wording in `coordinator-service.ts`. Tested in `CoordinatorWorkPanel.test.tsx`, `CoordinatorPanel.test.tsx`, `coordinator-worker-turns.test.ts`, `coordinator-worker-turns-remote.test.ts`. |
| 0260 | 2. Add row actions: Answer and Address | Moved to to-do [4940](../../todo/coordinator-and-multi-review/4940-work-row-answer-and-address.md) | As decided in the ticket, with the report's reasoning. |
| 0280 | 1. Show remote workers' prompts | Done with fakes; two real nodes moved to to-do [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md) task 1 | `useRemoteHumanPrompts.ts`, `normalizeRemoteHumanPromptEntry` in `human-prompts.ts`, the node-qualified key in `workerItem`. Tested in `useRemoteHumanPrompts.test.tsx`, `human-prompts.test.ts`, `coordinator-work-items.test.ts`. |
| 0280 | Security check | Passed: the link and code are shown | See the Part 0280 security check section above this table. |
| 0280 | Needs verification: any other route in practice | Moved to to-do [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md) task 1 | Needs two nodes; other real nodes were out of bounds. The code still shows no other route: `noteWorkerHumanPrompt` skips `nodeId`. |
| 0450 | 1. Say what the next wake waits for | Done, on narrow screens | `nextWakeLine` in `coordinator-work-items.ts`, `CoordinatorNextWakeLine` in `CoordinatorWorkPanel.tsx`. It sits under the conversation group, not directly under the last message. Tested in `coordinator-work-items.test.ts`, `CoordinatorWorkPanel.test.tsx`; seen on an isolated profile. |
| 0450 | 2. Notify: extend the sound service | Done; hearing it after a real wake moved to to-do [4942](../../todo/coordinator-and-multi-review/4942-c7-live-checks.md) task 3 | `coordinator-wake-attention` (`environment-attention.ts`, `storage-changes.ts`, `backend-event-fanout.ts`, `coordinator-service.ts`), `useNotificationSoundService.ts`, `coordinatorReport` in `notification-sounds.ts`, a row in `SoundsSettings.tsx`. Tested in `useNotificationSoundService.test.tsx`, `notification-sounds.test.ts`, `client-state.test.ts`, `environment-attention.test.ts`, `coordinator-worker-turns.test.ts`. |
| 0450 | 2. Notify: desktop notification | Moved to to-do [4941](../../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md) | Out of scope, as decided in the ticket. |
