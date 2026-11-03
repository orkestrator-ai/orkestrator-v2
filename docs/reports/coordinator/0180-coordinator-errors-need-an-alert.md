# Coordinator action errors are still collapsed and silent

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Show action errors as an alert**: visible without expanding, announced, and cleared by the next successful action. Status: open.

### 1. Show action errors as an alert

**Problem.** A failed create, close, select, pause or Git action is folded behind a one-line disclosure with no announcement to assistive technology.

**Context.** The masking half is fixed (see [Current state](#current-state)).

**Investigation.** `CoordinatorErrorDetails` is a `<details>` with no role (`CoordinatorPanelNotices.tsx:118-125`), rendered at `CoordinatorPanel.tsx:995-997`. `CoordinatorBanner` already sets `role="alert"` for the error tone (`CoordinatorPanelNotices.tsx:102`). `closeConversation` does not clear the previous error before it runs (`CoordinatorPanel.tsx:847-856`), unlike the other actions.

**Decisions.**

- **Banner or toast?**
  - **`CoordinatorBanner` with a dismiss button, for action errors only; keep Git's retained error as a disclosure (recommended).**
    - Pros: stays visible; matches paused and startup notices; the existing role applies.
    - Cons: one more row under the toolbar while an error stands.
  - **A toast.**
    - Pros: takes no space.
    - Cons: disappears before a long error can be read, and the app's toasts sit away from the action.

## Current state

- `e5245dfd6` (#1644) separated the two: Git's error and the coordinator's error each have their own line, and an action failure that only repeats the Git error is shown once (`CoordinatorPanel.tsx:866-868`, `:992-997`). A retained Git error no longer masks an action failure.

## Related

- [Coordinator report, 4.4 (U4)](../2026-10-27-coordinator.md#44-ui-and-ux)
