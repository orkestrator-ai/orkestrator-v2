# C10: Explanations

This file combines 4 reports into one batch to build together. Copy in the notices file. `0320` and `0330` link to each other.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0320](#0320-side-agents-are-never-explained) | Low | A tooltip, hint and placeholder for side agents. |
| [0330](#0330-explain-the-coordinator-once-in-the-product) | Low | A dismissible first-run card.: Explain the coordinator once, in the product |
| [0400](#0400--commands-in-the-coordinator-composer-are-undiscoverable) | Low | Discoverability of `!` commands, the footer wording, and a first message starting with `!`. |
| [0240](#0240-make-the-read-only-tier-legible) | Medium | Naming the tier in the picker and badge, and removing the repeated caveat. |

## 0320: Side agents are never explained

### Task analysis

#### Tasks

1. **Explain side agents where they start**: a tooltip on New side agent, and a hint and its own placeholder in a side composer. Status: open.

#### 1. Explain side agents where they start

**Problem.** Nothing says a side agent can read and mail the main but cannot launch workers, or why anyone would want one.

**Context.** The main now has starter prompts and a placeholder, deliberately withheld from side agents (`CoordinatorPanel.tsx:802-806`).

**Investigation.** The strip button has an icon and label with no `title` (`CoordinatorPanel.tsx:1126-1141`). Every composer shares `COORDINATOR_COMPOSER_PLACEHOLDER`, "What would you like to get done?" (`:798`, `CoordinatorPanelNotices.tsx:17`), which is misleading for a conversation that cannot launch anything. "side agent" appears in the web app only as this label and in comments.

**Decisions.** None: use the report's wording for the tooltip and hint, and pass a side-specific placeholder when `conversation.role === "side"`.

## 0330: Explain the coordinator once, in the product

### Task analysis

#### Tasks

1. **Add a first-run card**: a dismissible explanation in the empty main composer, reopened from a "?" in the toolbar. Status: open.

#### 1. Add a first-run card

**Problem.** The coordinator's model differs from any other tab: read-only, delegating, a main and side agents, one platform per conversation, woken by mail. Nothing states this in one place.

**Context.** The report's starter prompts exist (see [Current state](#current-state)), with different text from its examples. Its fourth line refers to Change agent, which C8 built: a button on the assigned main tab and an item in its tab menu ([One main coordinator](../../architecture/coordinator.md#one-main-coordinator-and-side-agents)).

**Investigation.** The nearest thing is the isolation badge's tooltip (`CoordinatorPanelNotices.tsx:60-80`), which covers only the read-only part. `unassignedStarterPrompts` is passed for the main only (`CoordinatorPanel.tsx:804-806`), so the empty state already has a slot for this.

**Decisions.**

- **How is dismissal stored?**
  - **Per user, in the UI store like other view preferences (recommended).**
    - Pros: no backend change; one dismissal covers all projects, since the model does not vary by project.
    - Cons: shows again on another client.
  - **Per project.**
    - Pros: a reminder in each new project.
    - Cons: repetitive for anyone with several projects.

### Current state

- `e5245dfd6` (#1644) added `COORDINATOR_STARTER_PROMPTS` (`CoordinatorPanelNotices.tsx:10-15`) and the placeholder.

## 0400: `!` commands in the coordinator composer are undiscoverable

### Task analysis

#### Tasks

1. **Make them discoverable and correct the footer**: mention `!` commands, and stop the footer contradicting them. Status: open.
2. **Handle a first message starting with `!`**: more than a toast. Status: open.

#### 1. Make them discoverable and correct the footer

**Problem.** Nothing shows that `!` runs a command as the user, and the footer says commands run elsewhere.

**Context.** `!` commands are the user's own action, outside the read-only boundary by design (`docs/architecture/coordinator.md:1075-1102`).

**Investigation.** The placeholder is "What would you like to get done?" (`CoordinatorPanelNotices.tsx:17`). The footer says "Code changes, commands, builds and fixes run in build pipelines or prompt environments." (`CoordinatorPanel.tsx:1157`).

**Decisions.** None: reword the footer to speak of the coordinator's work, and add a short hint near the composer rather than in the placeholder.

#### 2. Handle a first message starting with `!`

**Problem.** The first message cannot be a command, and the user learns that only from a passing toast, with the text still in the box.

**Context.** A command needs a conversation to show it and an agent to hear about it, and neither exists yet (`AgentNativeTab.helpers.tsx:877-884`).

**Investigation.** The toast does explain the rule; it is the delivery that is weak.

**Decisions.**

- **What should happen?**
  - **Keep the rule and show the same text inline under the composer (recommended).**
    - Pros: no behaviour change; survives until read.
    - Cons: a state for one rare case.
  - **Run it anyway by starting the conversation first.**
    - Pros: does what the user asked.
    - Cons: binds a platform and starts a provider session for a shell command.

## 0240: Make the read-only tier legible

### Task analysis

#### Tasks

1. **Show the tier by name**: a pill in the picker and the toolbar badge, with a popover that explains it. Status: open.
2. **Stop repeating the caveat**: a picker note does not say "cannot verify" twice. Status: open.

#### 1. Show the tier by name

**Problem.** The tier is the main safety fact the user chooses, and its name is never shown. The badge also calls two different tiers "advisory".

**Context.** Tiers are `enforced`, `provider-configured` and `advisory` (`docs/architecture/coordinator.md:482-486`). The snapshot carries them per platform.

**Investigation.** `advisoryPlatform` is set whenever the tier is not `enforced` (`CoordinatorPanel.tsx:862-865`), so a `provider-configured` Claude or Cursor reads "Read-only protection is advisory" (`CoordinatorPanelNotices.tsx:55-57`), and the tooltip says Orkestrator "cannot enforce that" (`:66-71`). In the picker a platform's caveat is an amber marker and a title (`AgentModelPicker.tsx:209-222`). Nothing links the safety-level setting.

**Decisions.**

- **Where does the explanation live?**
  - **A pill on each platform row and on the badge, with the badge's tooltip giving the tier's sentence and a link to Settings (recommended).**
    - Pros: the existing focusable tooltip already holds this text; `requestGlobalSettings("platforms")` exists.
    - Cons: tooltips with links are awkward by touch, so the link may need a popover.
  - **Leave the picker and only correct the badge's wording.**
    - Pros: fixes the wrong label at once.
    - Cons: the user still chooses a platform without seeing its tier.

#### 2. Stop repeating the caveat

**Problem.** A picker note can state the same limit twice.

**Context.** Part of U13 in the report.

**Investigation.** `platformNotes` appends "Orkestrator cannot verify this boundary independently." to any non-enforced reason (`CoordinatorPanel.tsx:338-341`), and a reason from the enforcement matrix can already say so: Cursor's ends "exposes no approval callback to verify them" (`packages/protocol/src/graphs/capability-enforcement.ts:199`).

**Decisions.** None: once the pill says the tier, drop the appended sentence and rely on the reason text.

## Related

- [Coordinator report, 4.4 (U8)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 5.2](../2026-10-27-coordinator.md#52-explain-the-model-once-in-the-product)
- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 5.3](../2026-10-27-coordinator.md#53-make-the-read-only-tier-legible) and [4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0026-coordinator-read-only-adapters.md](../../todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md): the per-platform decisions behind the tiers

## Outcome

Built on `main` at `a0a6d6206`. Every task was re-checked against that code
first; every finding still held (line numbers had moved, mostly into
`CoordinatorConversationPane.tsx` and `CoordinatorToolbar.tsx`). No task was
carried into a to-do, so no to-do was needed.

| Part | Task | Outcome | Code | Tests |
| --- | --- | --- | --- | --- |
| 0320 | 1. Explain side agents where they start | Done | New side agent's `title` is `COORDINATOR_SIDE_AGENT_EXPLANATION` (`CoordinatorPanel.tsx`); a side composer gets `COORDINATOR_SIDE_COMPOSER_PLACEHOLDER` ("Ask a question about this project") and the explanation as its `composerHint` (`CoordinatorConversationPane.tsx`); the hint renders under both the unassigned and the assigned composer (`AgentNativeTab.helpers.tsx`, `AgentNativeTab.controller.tsx`) | `CoordinatorPanel.tabs.test.tsx` ("New side agent keeps its name…"); `CoordinatorPanel.outcome.test.tsx` ("passes the outcome-first placeholder…", "a side composer says what a side agent is for…") |
| 0330 | 1. Add a first-run card | Done | `CoordinatorIntroCard` in the empty main composer (`unassignedIntro`), dismissed per user in the UI store (`coordinatorIntroDismissed`, persisted); the toolbar's "?" (`CoordinatorIntroButton`) shows the same lines as a menu, which works whatever the conversation's state (an assigned main has no empty composer to show the card in) | `CoordinatorPanel.outcome.test.tsx` ("the first-run card explains the coordinator until dismissed, and ? shows it again"); `uiStore.persistence.test.ts` ("a dismissed coordinator first-run card stays dismissed…") |
| 0400 | 1. Make `!` commands discoverable and correct the footer | Done | `COORDINATOR_COMMAND_HINT` under every coordinator composer; the footer now reads "The coordinator hands code changes, builds and fixes to build pipelines and prompt environments." (`CoordinatorPanel.tsx`) | `CoordinatorPanel.outcome.test.tsx` ("a side composer says…", "the footer speaks of the coordinator's work…") |
| 0400 | 2. Handle a first message starting with `!` | Done (recommended option: keep the rule, show it inline) | The toast is replaced by `FIRST_MESSAGE_COMMAND_RULE` shown under the unassigned composer (`role="alert"`) until the text no longer starts with `!`; the text stays in the box (`AgentNativeTab.helpers.tsx`) | `CoordinatorPanel.outcome.test.tsx` ("a first message starting with ! shows the rule under the composer…") |
| 0240 | 1. Show the tier by name | Done (recommended option; a menu instead of a tooltip) | The badge shows a "Read-only · <tier>" pill and opens a menu with the tier's meaning, the checkout and revision, and a "Coordinator safety level in Settings" item that opens Settings → Coordinator (C6's section, where the safety level lives) (`CoordinatorPanelNotices.tsx`); `provider-configured` is no longer called advisory. In the picker, `platformBadges` give each rail row a tier-coloured marker and the tier in its accessible name and tooltip, and the note for the platform in view starts with the pill (`AgentModelPicker.tsx`) | `CoordinatorPanel.outcome.test.tsx` ("the badge names the enforced tier…", "a provider-configured platform is named as such…", "an advisory platform is the only one…"); `CoordinatorPanel.test.tsx` ("a caveat on an available platform reaches the picker…"); `AgentModelPicker.test.tsx` ("names each platform's badge on its rail row…") |
| 0240 | 2. Stop repeating the caveat | Done | `platformNotes` passes the qualification reason unchanged; "Orkestrator cannot verify this boundary independently." is no longer appended (`CoordinatorPanel.tsx`) | `CoordinatorPanel.test.tsx` ("a caveat on an available platform reaches the picker…"); `AgentModelPicker.test.tsx` ("names each platform's badge…": the caveat is stated once) |

Choices that differ from the report's wording:

- **The badge's explanation is a menu, not a tooltip.** The report allowed a
  popover if a link in a tooltip does not work by touch. Radix tooltips do
  not open by touch and their content cannot take keyboard focus, and the app
  has no popover component, so the badge and the "?" use the existing
  dropdown menu, which opens by pointer, touch and keyboard.
- **The picker's rail rows are 32-pixel icon buttons**, so the tier name is
  in each row's accessible name and tooltip, with a marker coloured by tier;
  the visible pill is in the note for the platform in view, which follows the
  row the user selects.
- **The Settings link goes to Settings → Coordinator** (C6's section, which
  holds the safety level) rather than Platforms.

Screenshots of the live renderer were taken on an isolated `dev:test`
profile. An assigned conversation needs a first prompt, which would be a
billed provider turn, so the assigned-badge screenshots rewrote the
coordinator snapshot in the browser only (main assigned to Codex, tier
overridden) and refused every session start. The same paths are covered by
the component tests above against the real components.
