# Coordinator tab groups collapsed into one

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the C9 panel split applied.

### Tasks

1. **Find why the groups collapsed**: reproduce it, or show that a failed layout read cannot cause it. Status: open.
2. **Stop a failed read replacing the stored layout**: only if task 1 confirms that is the cause. Status: open (depends on 1).

### 1. Find why the groups collapsed

**Problem.** Once, on a real stack, two coordinator tab groups became one. Every open conversation ended up in that group in default order, and the group the user made was gone.

**Context.** Found while checking C9 (Panel split), part `0340` of the coordinator report, on an isolated `dev:test` profile. It is not one of that report's findings. The layout is stored per project by the backend (`coordinatorPaneLayoutStore.ts`), and `useCoordinatorSelection.ts` reconciles it against the open conversations. C9 moved that hook's code out of `CoordinatorPanel.tsx` without changing it, and did not touch the store or `coordinator-pane-layout.ts`.

**Investigation.** Seen once. A screenshot during a run showed two groups, and a later check, after a page reload, showed one group holding `Coordinator, Side 1, … Side 5` in sorted order. The group count was not logged in between, so the moment it changed is unknown. The steps between were: leaving the panel for Kanban and returning, a Sync, closing that browser, opening a new one, selecting the main tab, sending to it, selecting a side tab, and the reload. The host showed 99% CPU at one point in that session, though not necessarily at that moment. Sorted order is what `reconcileCoordinatorLayout(null, ids)` produces, so the panel probably reconciled from no stored layout.

It did not happen again. Afterwards, on that branch, the groups survived a split then two reloads, and a Sync, a send, a tab switch and a reload during a running turn; that second run did not leave for Kanban. On the panel from `main`, a run that started with two groups kept them through two reloads. So nothing shows this came from the split, and nothing shows it did not; the same sequence was never run against `main`.

One candidate, from reading the code only: `refresh` in `coordinatorPaneLayoutStore.ts` marks a project `ready` when `getCoordinatorPaneLayout` fails, with no layout held. The panel's first render then reads "ready, nothing stored" and writes the reconciled single group back through `setLayout`. That write uses revision 0, so a compare-and-swap conflict may rescue it; whether it does was not checked.

**Decisions.**

- **How to reproduce it?**
  - **Fail the read in a store test, then on a profile (recommended).** Make `getCoordinatorPaneLayout` reject once with a saved two-group layout on the backend, render the panel, and see what is saved.
    - Pros: decides the candidate quickly and needs no load.
    - Cons: if the candidate is wrong, the real cause is still unknown.
  - **Repeat reloads under load on a profile.**
    - Pros: tests the real path, whatever the cause.
    - Cons: slow and may not reproduce a rare race.

### 2. Stop a failed read replacing the stored layout

**Problem.** If task 1 confirms the candidate, one failed read costs the user their groups.

**Context.** Other clients receive the replacement as well, because the layout is shared through the backend.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **What should a failed first read do?**
  - **Stay not ready until a read succeeds, and retry (recommended).** The panel renders no groups until it knows what is stored.
    - Pros: never overwrites a layout it has not read.
    - Cons: a backend that keeps failing leaves no tab strip until it recovers, so the retry needs a bound and a visible state.
  - **Show a default layout but do not save it until a read succeeds.**
    - Pros: the panel stays usable during the failure.
    - Cons: changes made in that time have nothing to merge with, so the save logic gets a new case.

## Needs verification

Everything about the cause. Only the single collapse and the runs that did not repeat it were observed.

## Related

- `apps/web/src/stores/coordinatorPaneLayoutStore.ts`
- `apps/web/src/components/projects/useCoordinatorSelection.ts`
