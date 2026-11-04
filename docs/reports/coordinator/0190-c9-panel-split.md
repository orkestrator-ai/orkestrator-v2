# C9: Panel split

This file combines 4 reports into one batch to build together. `0340` recommends starting its split with `0220`. Going first gives the other panel batches smaller conflicts.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0340](#0340-split-coordinatorpanel) | Low | Splitting `CoordinatorPanel.tsx`. |
| [0220](#0220-first-sends-in-two-groups-can-drop-the-first-prompt) | Medium | Keying pending first launches by conversation. |
| [0350](#0350-one-busy-flag-disables-unrelated-controls) | Low | A `runAction` helper and separate busy flags. |
| [0190](#0190-branch-switch-and-sync-are-gated-on-the-wrong-turn) | Medium | Gating branch switch and Sync on any active turn. |

## 0340: Split `CoordinatorPanel`

### Task analysis

#### Tasks

1. **Split the component**: toolbar, selection, launches and conversation pane move out. Status: open.

#### 1. Split the component

**Problem.** One 1,227-line component holds the toolbar, Git actions, a selection serializer, the first-launch hold, layout bridging, notices and two dialogs, so unrelated changes collide there.

**Context.** Some has moved out since the report: `CoordinatorPanelNotices.tsx`, `CoordinatorWorkPanel.tsx` and `useCoordinatorWorkItems.ts`. The file still grew, from 1,150 lines.

**Investigation.** The selection serializer is at `CoordinatorPanel.tsx:245-299`, launches at `:133-141`, `:345-371` and `:584-640`, the upstream check at `:391-481`, the per-conversation render at `:724-831`, and the toolbar at `:878-1005`. Most state cards became banners (`CoordinatorPanelNotices.tsx`), so the report's `CoordinatorStateCard` is mostly no longer needed.

**Decisions.**

- **In what order?**
  - **`useCoordinatorLaunches` first, with [0220](#0220-first-sends-in-two-groups-can-drop-the-first-prompt); `CoordinatorToolbar` and `useCoordinatorSelection` when next touched (recommended).**
    - Pros: each split pays for itself by fixing or containing something.
    - Cons: the file stays large for a while.
  - **One refactor now.**
    - Pros: done at once.
    - Cons: a large diff in a component with heavy tests (`CoordinatorPanel.test.tsx`, 2,339 lines), and it collides with the other UI files here.

## 0220: First sends in two groups can drop the first prompt

### Task analysis

#### Tasks

1. **Key pending launches by conversation**: each first send keeps its own slot until its turn is observed. Status: open.

#### 1. Key pending launches by conversation

**Problem.** Send in Side 1, then in Side 2 before Side 1's first projection arrives. Side 1's prompt vanishes, and its conversation is bound to the platform with nothing sent.

**Context.** Tab groups put two composers on screen at once, so this needs only two quick sends.

**Investigation.** `pendingLaunch` is one slot (`CoordinatorPanel.tsx:133-141`), overwritten at `:367`. It is released on `launchObserved` for the one conversation it names (`:584-611`, `:640`). `renderConversation` scopes it so that one group cannot replay another's prompt (`:755`), but that does not stop the overwrite.

**Decisions.**

- **How to hold them?**
  - **A map keyed by conversation id, each released by its own observation (recommended).**
    - Pros: fixes it where it happens; the report's `useCoordinatorLaunches` split ([0340](#0340-split-coordinatorpanel)) can adopt it.
    - Cons: `launchObserved` selects one key today, so observation has to move into a child rendered per conversation or read the store per entry.
  - **Disable other composers while one launch is pending.**
    - Pros: small.
    - Cons: a slow first read blocks every group, and it hides rather than fixes the shared slot.

### Needs verification

Reported in the report and confirmed only by reading the code.

## 0350: One busy flag disables unrelated controls

### Task analysis

#### Tasks

1. **Add `runAction` and separate the flags**: one helper for the repeated pattern, with a Git busy state apart from a conversation busy state. Status: open.

#### 1. Add `runAction` and separate the flags

**Problem.** A branch fetch blocks New side agent, because one `operation` value disables everything.

**Context.** The report's `runAction` suggestion is the same change, since the helper is what sets the flag.

**Investigation.** `operation` is one state (`CoordinatorPanel.tsx:117-119`), with 12 `setOperation` calls. Every control disables on `operation !== null` (`:737`, `:832`, `:964`, `:974`, `:1031`, `:1130`). The set/try/finally pattern is repeated in `runGit`, `confirmUpstreamMerge`, `createConversation`, `setPaused`, `closeConversation` and the switch preparation. `closeConversation` does not clear the earlier error, which a helper would fix ([0180](0020-c6-errors-and-dead-ends.md#0180-coordinator-action-errors-are-still-collapsed-and-silent)).

**Decisions.** None: Git operations and conversation operations are independent on the backend (Git is serialized per repository root, conversations per project), so two flags are correct.

## 0190: Branch switch and Sync are gated on the wrong turn

### Task analysis

#### Tasks

1. **Gate on any active turn**: the controls disable while any conversation's turn runs, and say which one. Status: open.

#### 1. Gate on any active turn

**Problem.** With a side agent focused and the main running, the picker is enabled. The user confirms "Discard and switch", and the backend refuses.

**Context.** The panel's upstream check already computes the correct answer for an older backend.

**Investigation.** The backend's check counts the project home as well as every conversation (`apps/backend/src/core/index.ts:1256-1259`). `coordinatorTurnActive` reads only the selected conversation's phase (`CoordinatorPanel.tsx:579-581`, `:612-616`), and `branchSwitchDisabled` and `syncDisabled` use it (`:832-833`). The backend refuses when any turn is active (`project-git-service.ts:943-945`). `confirmUpstreamMerge`'s `turnRunning` walks every open conversation and the project home (`CoordinatorPanel.tsx:397-429`), but it reads the store once rather than subscribing.

**Decisions.**

- **Include the project home's turn?**
  - **Yes, and move the walk into one selector used by both (recommended).** The coordinator doc says nothing merges under a running coordinator or project-home turn.
    - Pros: one definition; the tooltip can name the busy conversation or "Home".
    - Cons: a selector across all projections re-runs on each projection change, so it must return a stable string or null.
  - **Coordinator conversations only.**
    - Pros: smaller.
    - Cons: the home's lease still refuses, with the same late error.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
- [Coordinator report, 4.4 (U10)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 4.4 (U5)](../2026-10-27-coordinator.md#44-ui-and-ux)
