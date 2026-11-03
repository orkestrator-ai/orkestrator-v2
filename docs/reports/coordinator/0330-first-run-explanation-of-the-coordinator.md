# Explain the coordinator once, in the product

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add a first-run card**: a dismissible explanation in the empty main composer, reopened from a "?" in the toolbar. Status: open.

### 1. Add a first-run card

**Problem.** The coordinator's model differs from any other tab: read-only, delegating, a main and side agents, one platform per conversation, woken by mail. Nothing states this in one place.

**Context.** The report's starter prompts exist (see [Current state](#current-state)), with different text from its examples. Its fourth line refers to Change agent, so wording depends on [0070](0070-change-agent-action-and-main-tab-marker.md).

**Investigation.** The nearest thing is the isolation badge's tooltip (`CoordinatorPanelNotices.tsx:60-80`), which covers only the read-only part. `unassignedStarterPrompts` is passed for the main only (`CoordinatorPanel.tsx:804-806`), so the empty state already has a slot for this.

**Decisions.**

- **How is dismissal stored?**
  - **Per user, in the UI store like other view preferences (recommended).**
    - Pros: no backend change; one dismissal covers all projects, since the model does not vary by project.
    - Cons: shows again on another client.
  - **Per project.**
    - Pros: a reminder in each new project.
    - Cons: repetitive for anyone with several projects.

## Current state

- `e5245dfd6` (#1644) added `COORDINATOR_STARTER_PROMPTS` (`CoordinatorPanelNotices.tsx:10-15`) and the placeholder.

## Related

- [Coordinator report, 5.2](../2026-10-27-coordinator.md#52-explain-the-model-once-in-the-product)
- [0320-side-agents-are-never-explained.md](0320-side-agents-are-never-explained.md)
