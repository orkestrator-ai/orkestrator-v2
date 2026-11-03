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
