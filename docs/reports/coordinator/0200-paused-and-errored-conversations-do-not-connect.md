# Paused conversations may not load their transcript

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Keep reads running while paused**: a paused or errored conversation still loads its transcript, with only sending held. Status: open.
2. **Say what Pause does**: the button states that it is project-wide and what waits. Status: open.

### 1. Keep reads running while paused

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

### 2. Say what Pause does

**Problem.** Pause gives no hint that it holds the whole project, including mail.

**Context.** The banner says "Messages will wait until you resume" (`CoordinatorPanel.tsx:1039`) only after the click.

**Investigation.** The button has no title (`CoordinatorPanel.tsx:971-979`).

**Decisions.** None: add a `title` saying that mail and new turns are held for this project's coordinator.

## Needs verification

Task 1's symptom was read from code and not seen. Pause, reload the app, and check whether the transcript appears; if it does, task 1 can close. The same applies to the startup-error state ([0020](0020-startup-failure-takes-down-whole-coordinator.md)).

## Related

- [Coordinator report, 4.4 (U6)](../2026-10-27-coordinator.md#44-ui-and-ux)
