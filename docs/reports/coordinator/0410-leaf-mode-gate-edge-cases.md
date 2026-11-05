# Leaf-mode gate edge cases

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Wait for portal status**: a leaf-mode node does not show or start its coordinator before status loads. Status: open.
2. **Handle an empty controller list**: do not render "controlled by .". Status: open.
3. **Decide what "open anyway" remembers**: session, or each visit. Status: open.

### 1. Wait for portal status

**Problem.** The coordinator can flash, and call `ensure`, before portal status says this node is in leaf mode.

**Context.** The realm branch already waits ("Checking repository coordination…", `LeafModeCoordinatorGate.tsx:116-127`). The local branch does not.

**Investigation.** `leafMode` is false while `status` is null (`:55`), so `:56` returns the children straight away. `portalLoaded` is available (`:39`).

**Decisions.** None: add the same pending state for the local branch while `portalLoaded` is false. A failed portal read has to fall through to the children, so that a coordinator remains usable if the portal is broken.

### 2. Handle an empty controller list

**Problem.** An empty list renders "It is controlled by .".

**Context.** Rare: leaf mode with no controller names known.

**Investigation.** `:59-61` and `:145`.

**Decisions.** None: use "the command node" as the realm branch does (`:60`).

### 3. Decide what "open anyway" remembers

**Problem.** The choice is `useState` (`:47`), so it resets on each visit.

**Context.** The report's "despite saying for this session" is out of date: the button now says only "Open this node's coordinator anyway" (`:169-171`). The component's doc comment still says "for this session" (`:18`).

**Investigation.** No store holds it.

**Decisions.**

- **Remember or not?**
  - **Remember per project for the app session, in the UI store (recommended).**
    - Pros: matches the comment, and is not annoying when returning to a tab.
    - Cons: state for a rare path.
  - **Keep per visit and fix the comment.**
    - Pros: no code; the warning is shown every time, on a node where acting may be a mistake.
    - Cons: repeated click for someone who means it.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)

## Outcome

Re-checked on 2026-11-05 against `main` at `69a3b4ca5`: every finding still
held, at the cited lines. Implemented in batch C-0410.

| Task | Outcome | Code | Tests |
| --- | --- | --- | --- |
| 1. Wait for portal status | Done. A node's coordinator tab shows "Checking repository coordination…" until portal status has loaded, so `CoordinatorPanel` (and its `ensureProjectCoordinator`) does not mount first. A failed status read marks the store loaded with no status, so the coordinator then opens as on any other node. | `LeafModeCoordinatorGate.tsx` (`PendingCoordination`, the `!onLeaf && !portalLoaded` branch) | `leaf-mode-coordinator-gate.test.tsx`: "a node shows neither the notice nor its coordinator until its portal status loads", "a node that is not in leaf mode opens its coordinator once its status loads", "a failed portal status read falls through to the coordinator" |
| 2. Handle an empty controller list | Done. An empty list, a missing list or blank names read "the command node", as the realm branch does; several names are joined, skipping blanks. | `LeafModeCoordinatorGate.tsx` (`controllerNames`, `named`) | "an empty controller list names the command node", "blank controller names name the command node", "several controllers are listed by name, skipping blank ones" |
| 3. Decide what "open anyway" remembers | Done, recommended option: remembered per node and project for the app session in the UI store, not persisted. The doc comment now says so. | `uiStore.ts` (`openedLeafCoordinators`, `openLeafCoordinator`), `LeafModeCoordinatorGate.tsx` (`leafCoordinatorGateKey`) | "opening anyway is remembered per project for the app session, not persisted", "a leaf window keys the choice by the leaf node, so the same project id elsewhere is not opened" |

No to-do was needed.
