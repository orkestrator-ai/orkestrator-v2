# Side agents are never explained

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Explain side agents where they start**: a tooltip on New side agent, and a hint and its own placeholder in a side composer. Status: open.

### 1. Explain side agents where they start

**Problem.** Nothing says a side agent can read and mail the main but cannot launch workers, or why anyone would want one.

**Context.** The main now has starter prompts and a placeholder, deliberately withheld from side agents (`CoordinatorPanel.tsx:802-806`).

**Investigation.** The strip button has an icon and label with no `title` (`CoordinatorPanel.tsx:1126-1141`). Every composer shares `COORDINATOR_COMPOSER_PLACEHOLDER`, "What would you like to get done?" (`:798`, `CoordinatorPanelNotices.tsx:17`), which is misleading for a conversation that cannot launch anything. "side agent" appears in the web app only as this label and in comments.

**Decisions.** None: use the report's wording for the tooltip and hint, and pass a side-specific placeholder when `conversation.role === "side"`.

## Related

- [Coordinator report, 4.4 (U8)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0330-first-run-explanation-of-the-coordinator.md](0330-first-run-explanation-of-the-coordinator.md)
