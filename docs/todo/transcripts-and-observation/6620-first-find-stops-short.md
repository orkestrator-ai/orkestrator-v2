# The first find after opening a long transcript can stop short of its match

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`.

### Tasks

1. **Bring the first find to its match**: a find made while most rows above the match are unmeasured should end with the match on screen. Status: open.

### 1. Bring the first find to its match

**Problem.** On a freshly opened transcript whose rows are much shorter than the list's estimate, the first find can stop well above its match. The find bar says "1 of 1", but the row is not mounted, so it has no current-match outline and no highlight. The reader sees unrelated rows and a "Scroll down" button.

**Context.** `VirtualizedMessageList` navigates through `TranscriptScrollController.navigateTo` with `align: "center"`. `<Virtuoso>` has `defaultItemHeight={320}`, so rows it has not measured count as 320 px. The fixture's rows are about 87 px. Scrolling mounts rows that then measure far smaller, so the list shrinks while the navigation runs.

**Investigation.** Seen 2026-11-05 in Chromium at 1600 by 900 with `e2e/fixture/TranscriptListRendersFixture.tsx` (112 display rows, 13 mounted at the bottom). The first query, `Fixture row 91`, targets display row 102. The list moved from `scrollTop` 31153 (height 32029) to 24514 (height 27615) and held there, showing display rows 78 to 96. The state was the same 300 ms and 2.8 s after the query. Every later query in the session landed, including ones further away (`Fixture row 40`, then `Fixture row 95`), once more rows were measured. The result is the same on `41f9eb638` with no other change, so it predates the 6280 work. The root cause was not established: nothing here shows why the controller's bounded navigation settles without the target mounted. `e2e/TranscriptListRenders.spec.ts` works around it with a first query it does not check (`openFind`).

**Decisions.**

- **What to do about it?**
  - **Reproduce it in a focused spec, then make a row navigation keep going until its target is mounted or its bound runs out (recommended).**
    - Pros: fixes the cause for every row navigation, not only find; the fixture already reproduces it.
    - Cons: touches the positioning code that follow and history restoration share, so `VirtuosoFollow`, `TranscriptPaging` and `TranscriptHold` must be run with it.
  - **Lower `defaultItemHeight` towards the real row height.**
    - Pros: one line, and smaller estimate errors.
    - Cons: the value was chosen to bound the cold-fill render count and to avoid overestimating new rows (see its comment), and a transcript with tall rows would still miss in the other direction.
  - **Leave it.**
    - Pros: no risk to scrolling; a second find works.
    - Cons: the first find in a tab looks broken.
