# First sends in two groups can drop the first prompt

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Key pending launches by conversation**: each first send keeps its own slot until its turn is observed. Status: open.

### 1. Key pending launches by conversation

**Problem.** Send in Side 1, then in Side 2 before Side 1's first projection arrives. Side 1's prompt vanishes, and its conversation is bound to the platform with nothing sent.

**Context.** Tab groups put two composers on screen at once, so this needs only two quick sends.

**Investigation.** `pendingLaunch` is one slot (`CoordinatorPanel.tsx:133-141`), overwritten at `:367`. It is released on `launchObserved` for the one conversation it names (`:584-611`, `:640`). `renderConversation` scopes it so that one group cannot replay another's prompt (`:755`), but that does not stop the overwrite.

**Decisions.**

- **How to hold them?**
  - **A map keyed by conversation id, each released by its own observation (recommended).**
    - Pros: fixes it where it happens; the report's `useCoordinatorLaunches` split ([0340](0340-coordinator-panel-does-too-much.md)) can adopt it.
    - Cons: `launchObserved` selects one key today, so observation has to move into a child rendered per conversation or read the store per entry.
  - **Disable other composers while one launch is pending.**
    - Pros: small.
    - Cons: a slow first read blocks every group, and it hides rather than fixes the shared slot.

## Needs verification

Reported in the report and confirmed only by reading the code.

## Related

- [Coordinator report, 4.4 (U10)](../2026-10-27-coordinator.md#44-ui-and-ux)
