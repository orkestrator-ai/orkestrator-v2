# C6: Errors and dead ends

This file combines 6 reports into one batch to build together. The index splits report section 5.4 across `0020`, `0180`, `0210` and `0250`. Includes backend work: `0020` adds an error to each conversation.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0020](#0020-one-conversations-startup-failure-takes-down-the-whole-coordinator) | High | Recording a startup failure on the conversation that failed, and showing it in that pane. |
| [0180](#0180-coordinator-action-errors-are-still-collapsed-and-silent) | Medium | Showing action errors as a visible, announced alert. |
| [0200](#0200-paused-conversations-may-not-load-their-transcript) | Medium | Loading the transcript while paused, and explaining Pause. |
| [0210](#0210-state-cards-tell-the-user-what-to-do-but-offer-no-way-to-do-it) | Medium | Buttons on state cards, naming the safety level as a reason, and gathering coordinator settings. |
| [0250](#0250-failed-background-reads-leave-the-panel-silently-stale) | Medium | A stale indicator when background reads fail. |
| [0440](#0440-web-research-settings-limit-message-and-enter) | Low | A limit message and Enter to add in web research settings. |

## 0020: One conversation's startup failure takes down the whole coordinator

### Task analysis

#### Tasks

1. **Record the startup error on the conversation**: a bridge failure marks the conversation that failed, and the workspace stays `ready` unless the failure really is workspace-wide. Status: open.
2. **Show it in that conversation's pane**: name the conversation, with Retry, Close conversation and Copy error. Status: open (depends on 1).

#### 1. Record the startup error on the conversation

**Problem.** When any one conversation's bridge fails to start, the workspace goes to `lifecycleState: "error"`. That state is read as "the coordinator is down" everywhere, so a failed side agent stops the main and its workers' mail.

**Context.** `CoordinatorConversation` (`packages/protocol/src/coordinator.ts:98`) has no error field. `lastStartupError` lives on the workspace (`:685`).

**Investigation.** `commands-servers.ts:1439-1440` sets `lifecycleState: "error"` on the workspace while clearing only the failing conversation's bridge fields. The readers treat anything but `ready` as unavailable: Control MCP refuses every conversation's credential with 409 (`control-mcp-server.ts:571`), mail is skipped as `environment_unready` (`agent-mail-service.ts:768`) and runtime resolution returns `workspace-not-ready` (`coordinator-runtime.ts:50`). A later successful start of any conversation writes `ready` and clears the error (`commands-servers.ts:1400-1401`), so the state can flip between conversations. Recovery is `ensure`, which resets the workspace to `ready` (`coordinator-service.ts:469-480`).

**Decisions.**

- **Where does the error live?**
  - **A `startupError` on the conversation, gating only that conversation's runtime (recommended).**
    - Pros: a failed side agent leaves the main and the wake path working; matches the one-bridge-per-conversation design.
    - Cons: every reader of `lifecycleState` above needs a conversation-level check; older clients still read the workspace field during a mixed-version window.
  - **Keep the workspace state, change only the message.**
    - Pros: small.
    - Cons: the outage stays; only the wording improves.

#### 2. Show it in that conversation's pane

**Problem.** The banner does not say which conversation failed, and offers Retry only.

**Context.** Since `e5245dfd6` (#1644) the failure is a banner rather than a card replacing every pane, so the report's point about the transcript being replaced no longer holds as written. See [Current state](#current-state).

**Investigation.** `CoordinatorPanel.tsx:1007-1022` renders one workspace-level `CoordinatorBanner` above the panes. Its Retry calls `load()` (`:1011`) with no busy state. `connectionEnabled` (`:799-801`) is false for every conversation while the workspace is not `ready`.

**Decisions.**

- **Where does the notice render?**
  - **Reuse `CoordinatorBanner` inside `renderConversation`, next to the existing provider banner at `:759-776` (recommended).**
    - Pros: same component and placement as the other per-conversation state; split panes show the right notice on the right pane.
    - Cons: a workspace-wide failure, if one is kept, still needs the toolbar-level banner too.
  - **Keep one banner and name the conversation in it.**
    - Pros: no layout change.
    - Cons: Close and Retry then act on a conversation that may not be in front.

### Current state

- `e5245dfd6` (#1644) made startup failure a banner, so the panes stay mounted. Their connections are still disabled (`CoordinatorPanel.tsx:799-801`); see [0200](#0200-paused-conversations-may-not-load-their-transcript).

## 0180: Coordinator action errors are still collapsed and silent

### Task analysis

#### Tasks

1. **Show action errors as an alert**: visible without expanding, announced, and cleared by the next successful action. Status: open.

#### 1. Show action errors as an alert

**Problem.** A failed create, close, select, pause or Git action is folded behind a one-line disclosure with no announcement to assistive technology.

**Context.** The masking half is fixed (see [Current state](#current-state-1)).

**Investigation.** `CoordinatorErrorDetails` is a `<details>` with no role (`CoordinatorPanelNotices.tsx:118-125`), rendered at `CoordinatorPanel.tsx:995-997`. `CoordinatorBanner` already sets `role="alert"` for the error tone (`CoordinatorPanelNotices.tsx:102`). `closeConversation` does not clear the previous error before it runs (`CoordinatorPanel.tsx:847-856`), unlike the other actions.

**Decisions.**

- **Banner or toast?**
  - **`CoordinatorBanner` with a dismiss button, for action errors only; keep Git's retained error as a disclosure (recommended).**
    - Pros: stays visible; matches paused and startup notices; the existing role applies.
    - Cons: one more row under the toolbar while an error stands.
  - **A toast.**
    - Pros: takes no space.
    - Cons: disappears before a long error can be read, and the app's toasts sit away from the action.

### Current state

- `e5245dfd6` (#1644) separated the two: Git's error and the coordinator's error each have their own line, and an action failure that only repeats the Git error is shown once (`CoordinatorPanel.tsx:866-868`, `:992-997`). A retained Git error no longer masks an action failure.

## 0200: Paused conversations may not load their transcript

### Task analysis

#### Tasks

1. **Keep reads running while paused**: a paused or errored conversation still loads its transcript, with only sending held. Status: open.
2. **Say what Pause does**: the button states that it is project-wide and what waits. Status: open.

#### 1. Keep reads running while paused

**Problem.** The report's fix was to keep the transcript while paused. The pane now stays, but it may be empty: a paused tab does not connect at all.

**Context.** `e5245dfd6` (#1644) replaced the full-pane "paused" card with a banner, and its comment says the transcript stays readable (`CoordinatorPanelNotices.tsx:85-88`).

**Investigation.** `connectionEnabled` is `lifecycleState === "ready" && …` (`CoordinatorPanel.tsx:799-801`), passed as `enabled` to `useNativeAgentSession` (`AgentNativeTab.controller.tsx:553-554`). With `enabled` false the refresh returns null (`useNativeAgentSession.ts:2208`), `connect` does nothing (`:2694-2697`) and no read starts (`:2965-2973`). A projection already in the store would still render, which covers pausing an open tab. It would not cover a reload or a first visit while paused. Existing tests look only at the banner and Resume (`CoordinatorPanel.test.tsx:1468-1476`, `:1556-1560`). `workspace-not-ready` also stops the runtime (`coordinator-runtime.ts:50`), so a read path that needs it would have to change too.

**Decisions.**

- **Split reads from sends?**
  - **Add a separate prop, such as `sendingHeld`, and let `enabled` stay true (recommended).**
    - Pros: the banner's promise holds in every case; the composer can say why it is disabled.
    - Cons: touches the shared session hook's callers, and connecting must not start a provider while paused, which needs checking.
  - **Keep it, and hydrate the projection with one read on mount.**
    - Pros: no new mode in the hook.
    - Cons: no live updates on a tab that can still receive background state.

#### 2. Say what Pause does

**Problem.** Pause gives no hint that it holds the whole project, including mail.

**Context.** The banner says "Messages will wait until you resume" (`CoordinatorPanel.tsx:1039`) only after the click.

**Investigation.** The button has no title (`CoordinatorPanel.tsx:971-979`).

**Decisions.** None: add a `title` saying that mail and new turns are held for this project's coordinator.

### Needs verification

Task 1's symptom was read from code and not seen. Pause, reload the app, and check whether the transcript appears; if it does, task 1 can close. The same applies to the startup-error state ([0020](#0020-one-conversations-startup-failure-takes-down-the-whole-coordinator)).

## 0210: State cards tell the user what to do but offer no way to do it

### Task analysis

#### Tasks

1. **Add the button each state recommends**: Settings or Repository links on the provider banner, empty-platform message and no-checkout card. Status: open.
2. **Name the safety level as the reason**: a platform held back by the setting says so. Status: open.
3. **Gather coordinator settings**: a section or deep links for safety level, web research, status updates and messaging. Status: open.

#### 1. Add the button each state recommends

**Problem.** Three states give advice with nothing to click.

**Context.** The provider state has improved: it is now a banner, not a replacement, and has a Retry button (`CoordinatorPanel.tsx:759-776`). Retrying does not help when the cause is a setting.

**Investigation.** "Connect a local checkout" names Repository settings but has no button (`CoordinatorPanel.tsx:655-662`). `emptyPlatformsMessage` is plain text (`:807`, rendered at `AgentNativeTab.helpers.tsx:921`). The deep-link paths exist: `requestGlobalSettings(section)` (`apps/web/src/lib/settings-navigation.ts:44`, with `platforms` and `messaging` sections) and the `repository-settings` dialog (`apps/web/src/stores/appDialogStore.ts:19`).

**Decisions.** None: use those two paths. Pass an action prop beside the message rather than parsing it. `requestGlobalSettings` already forwards from a remote realm to its window.

#### 2. Name the safety level as the reason

**Problem.** A platform refused by the safety level shows its own caveat, not "raise the safety level", so the user cannot tell the setting is why.

**Context.** This is the note under finding A7 in the report.

**Investigation.** `coordinator-providers.ts:165-172`: the sentence about the safety level is used only when the platform has no reason of its own. The picker shows only available platforms, so this surfaces on the provider banner (`CoordinatorPanel.tsx:773`).

**Decisions.**

- **How is the reason combined?**
  - **Put the setting sentence first, then the platform's caveat (recommended).**
    - Pros: leads with what the user can change.
    - Cons: a longer string in `reason`.
  - **Add a structured `heldBySafetyLevel` flag and let the UI word it.**
    - Pros: the button can appear only in that case.
    - Cons: a protocol change, which an older client ignores.

#### 3. Gather coordinator settings

**Problem.** Safety level and web research are under Agent platforms, status updates under Messaging.

**Context.** The settings menu is a flat list in `SettingsPage.tsx:60`.

**Investigation.** `GlobalSettings.sections.tsx:1149` has the safety level, `CoordinatorWebResearchSettings.tsx` the research choices, and `MessagingSettings.tsx:212` the status updates.

**Decisions.**

- **Move, or link?**
  - **Add a Coordinator section and move the first two there; link the messaging prerequisite (recommended).**
    - Pros: one place for one feature; messaging stays where every agent's messaging lives.
    - Cons: docs that give the path "Settings → Agent platforms → Coordinator safety level" must change (`docs/architecture/coordinator.md:488`, `:575`).
  - **Keep them and add links from the panel only.**
    - Pros: no move.
    - Cons: scattered settings remain for anyone starting from Settings.

## 0250: Failed background reads leave the panel silently stale

### Task analysis

#### Tasks

1. **Show when the panel is out of date**: a stale indicator when a background coordinator or Git read fails. Status: open.

#### 1. Show when the panel is out of date

**Problem.** After a background read fails, the panel keeps showing the old state with no sign. A worker can look running after it stopped.

**Context.** The rest of the report's section 5.4 is spread over [0020](#0020-one-conversations-startup-failure-takes-down-the-whole-coordinator), [0180](#0180-coordinator-action-errors-are-still-collapsed-and-silent) and [0210](#0210-state-cards-tell-the-user-what-to-do-but-offer-no-way-to-do-it). This is the part they do not cover. The app already has freshness wording in `apps/web/src/lib/view-freshness.ts`, described in `docs/architecture/event-snapshot-recovery.md` ("Freshness in the UI").

**Investigation.** Both `useCoordinatedRead` callbacks ignore everything but `current`: `useCoordinatorPanelData.ts:224-225` for the view and `:254-255` for Git. `CoordinatorPanel.tsx` does not import `view-freshness`. The loading error reaches the user only before a snapshot exists (`:679-697`).

**Decisions.**

- **How much to show?**
  - **Use `view-freshness` wording in a small line in the toolbar, only while stale (recommended).**
    - Pros: same words as other views; nothing appears in normal use.
    - Cons: transient failures can flicker, so it needs the existing retry settled first.
  - **Turn each background failure into an error banner.**
    - Pros: cannot be missed.
    - Cons: too loud for a read that usually recovers on its own.

## 0440: Web research settings: limit message and Enter

### Task analysis

#### Tasks

1. **Explain the server limit and accept Enter**: say why Add is disabled, and let Enter add. Status: open.

#### 1. Explain the server limit and accept Enter

**Problem.** At the limit Add is disabled with no reason, and Enter in either field does nothing.

**Context.** The limit is `MAX_COORDINATOR_RESEARCH_MCP_SERVERS`, eight servers.

**Investigation.** `canAdd` includes the limit (`CoordinatorWebResearchSettings.tsx:65-68`), while `draftProblem` does not (`:59-64`), so no alert appears. The inputs and button are not in a form (`:143-173`).

**Decisions.** None: include the limit in `draftProblem`, and wrap the row in a form whose submit runs the Add handler, keeping `type="button"` off that one button. Pressing Enter inside the parent settings page must not trigger anything else, so stop the submit there.

### Current state

- The report's third point is not a bug: the duplicate check at `:62` is case-sensitive, but names can only be lowercase (`SERVER_NAME`, `packages/protocol/src/coordinator-web-research.ts:56`), so an upper-case name is refused with its own message first.

## Related

- [Coordinator report, 4.4 (U3)](../2026-10-27-coordinator.md#44-ui-and-ux) and [5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
- [Coordinator report, 4.4 (U4)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 4.4 (U6)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 4.4 (U9)](../2026-10-27-coordinator.md#44-ui-and-ux), [4.3 (A7)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools) and [5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
- [Coordinator report, 5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
- [0051-client-reconnect-and-freshness.md](../../todo/transcripts-and-observation/0051-client-reconnect-and-freshness.md): the freshness work this should follow
- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
