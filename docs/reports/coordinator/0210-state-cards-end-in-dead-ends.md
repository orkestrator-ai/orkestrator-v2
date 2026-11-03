# State cards tell the user what to do but offer no way to do it

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add the button each state recommends**: Settings or Repository links on the provider banner, empty-platform message and no-checkout card. Status: open.
2. **Name the safety level as the reason**: a platform held back by the setting says so. Status: open.
3. **Gather coordinator settings**: a section or deep links for safety level, web research, status updates and messaging. Status: open.

### 1. Add the button each state recommends

**Problem.** Three states give advice with nothing to click.

**Context.** The provider state has improved: it is now a banner, not a replacement, and has a Retry button (`CoordinatorPanel.tsx:759-776`). Retrying does not help when the cause is a setting.

**Investigation.** "Connect a local checkout" names Repository settings but has no button (`CoordinatorPanel.tsx:655-662`). `emptyPlatformsMessage` is plain text (`:807`, rendered at `AgentNativeTab.helpers.tsx:921`). The deep-link paths exist: `requestGlobalSettings(section)` (`apps/web/src/lib/settings-navigation.ts:44`, with `platforms` and `messaging` sections) and the `repository-settings` dialog (`apps/web/src/stores/appDialogStore.ts:19`).

**Decisions.** None: use those two paths. Pass an action prop beside the message rather than parsing it. `requestGlobalSettings` already forwards from a remote realm to its window.

### 2. Name the safety level as the reason

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

### 3. Gather coordinator settings

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

## Related

- [Coordinator report, 4.4 (U9)](../2026-10-27-coordinator.md#44-ui-and-ux), [4.3 (A7)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools) and [5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
- [0020-startup-failure-takes-down-whole-coordinator.md](0020-startup-failure-takes-down-whole-coordinator.md)
