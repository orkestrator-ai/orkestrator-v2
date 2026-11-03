# Coordinator toolbar on narrow screens

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Collapse New side agent to an icon**: and reduce toolbar wrapping when narrow. Status: open.

### 1. Collapse New side agent to an icon

**Problem.** The toolbar wraps onto several rows, and "New side agent" keeps its full label in a tab strip that scrolls.

**Context.** The badge text is shorter than it was, and the path and revision moved to its tooltip.

**Investigation.** The toolbar uses `flex-wrap` (`CoordinatorPanel.tsx:879`). The strip button always renders its label (`:1139-1140`). The strip scrolls (`TAB_STRIP_CLASS`, `TabShell.tsx:18`).

**Decisions.** None: hide the label under the small breakpoint and keep an `aria-label`, with [0320](0320-side-agents-are-never-explained.md)'s tooltip on it.

## Needs verification

How many rows the toolbar takes at phone width now; seen only in code.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
