# The native transcript list re-renders its rows on every render of the tab

## Task analysis

Analysed 2026-11-05 against `main` at `533acf703`, with 5960 task 1 applied. Carried over from 5960 (native tab render churn) task 2, which found the source of the nested update and recorded why it was not removed there. 5960 is deleted; its last version, with the outcome table, is in Git history at `ba209e5b1` (`git show ba209e5b1:docs/todo/cross-cutting/5960-native-tab-render-churn.md`).

### Tasks

1. **Stop re-rendering the list when nothing it shows changed**: give `<Virtuoso>` the same props across a render of the tab that changes nothing in the transcript. Status: done 2026-11-05.
2. **No-op file-mention writes on a caret move**: `useFileMentions.handleCursorChange` sets state to the values it already holds. Status: decided 2026-11-05: left as it is, because Chromium shows no cost.

### 1. Stop re-rendering the list when nothing it shows changed

**Problem.** Every render of a native agent tab with a platform commits twice: the update, then a `nested-update` that re-renders the visible transcript rows and the list footer, even when nothing in the transcript changed.

**Context.** `VirtualizedMessageList` (`apps/web/src/components/chat/VirtualizedMessageList.tsx:936`) renders `react-virtuoso`'s `<Virtuoso>`. `react-virtuoso` 4.18.19's `systemToComponent` runs a layout effect with no dependency list that republishes every prop into the list's internal store on each render of `<Virtuoso>`, toggling `propsReady` as it goes. The list's internals read those props through `useSyncExternalStore`, so each publish forces a synchronous re-render: the nested update. On a render that changes the transcript (a streamed frame) the nested commit is where the rows update, so that work is needed. On a render that changes nothing the list shows, it is avoidable.

`<Virtuoso>` gets new props on every render because nothing on the way down is stable:

- `VirtualizedMessageList` builds `computeItemKey` and `itemContent` inline (`:941`, `:942`), and `context` (`:366`) is memoised on `footer`, `header` and `emptyState`, which change every render.
- `NativeChatShell` passes `renderMessage`, `emptyState` and `footer` as inline JSX and closures (`NativeChatShell.tsx:460`, `:477`, `:492`).
- `SharedNativeAgentController` passes `transcriptHeader` (`AgentNativeTab.controller.tsx:3771`) and `messageActions` (`:3908`) inline, and re-renders whenever any of its own inputs change.

`SuborkTranscriptDialog` also renders `VirtualizedMessageList`.

**Investigation.** Measured 2026-11-05 for 5960 in Chromium with development React: a temporary `e2e/fixture` page with real `AgentNativeTab`s at 1600 by 900, a fake `invoke` serving a 100-row fixture transcript, and 50 writes to the environment's `initialPrompt` (a field the controller selects) 40 ms apart. A temporary React DevTools hook named the code that scheduled each update and the components each commit rendered.

| Tabs holding the fixture | Writes | `update` commits | `nested-update` commits | Mean `update` | Mean `nested-update` |
| --- | --- | --- | --- | --- | --- |
| One | 50 | 52 | 52 | 6.7 to 7.9 ms | 1.6 to 1.8 ms |
| Two | 50 | 54 | 54 | 10.5 to 10.7 ms | 2.1 to 2.2 ms |

Every nested update was scheduled from `react-virtuoso`'s republish, about seven per commit, and rendered 11 `TranscriptRow`s plus the footer. A throwaway check that memoised the `<Virtuoso>` element on `messages` alone (wrong in general, because rows would stop following anything else, and reverted at once) left 2 nested updates with one tab and 5 with two, all from the tab's start-up. Its render times were noisy and are not a result. happy-dom cannot measure this: `AgentNativeTab.render-count.test.tsx` replaces the virtualizer, because it renders nothing there.

**Decisions.**

- **How to stop it?**
  - **Make every input of `<Virtuoso>` stable across a render that changes nothing it shows (recommended).** Memoise `transcriptHeader` and `messageActions` in the controller, `renderMessage`, `footer` and `emptyState` in `NativeChatShell` on what they read, and `computeItemKey` and `itemContent` in `VirtualizedMessageList` on `renderMessage`, `firstItemIndex`, the find state, `highlightedItemKey`, `resolvePreviousMessage`, `tracker`, `arrivals` and `messages`. Prove it with a Chromium spec in `e2e/` that counts nested updates against a fixture transcript and checks that rows still follow each input that changes them (find, highlight, expansion, actions, footer status).
    - Pros: removes about 1.6 ms per visible tab per render under development React on renders that do not change the transcript; makes the remaining nested update mean a real row change.
    - Cons: many dependencies across three components, two of them shared; a dependency left out leaves a row showing stale content, which only a browser test catches.
  - **Memoise the `<Virtuoso>` element in `VirtualizedMessageList` only.**
    - Pros: one file.
    - Cons: does nothing while its callers pass new props every render, which they all do today.
  - **Leave it.**
    - Pros: no risk to how rows update; a streamed frame needs the row work anyway.
    - Cons: a render of a visible tab for any other reason re-renders its visible rows a second time.

### 2. No-op file-mention writes on a caret move

**Problem.** `useFileMentions.handleCursorChange` calls `setIsMenuOpen(false)` and `setSearchQuery("")` (`apps/web/src/hooks/useFileMentions.ts:117-118`) on every caret move with no `@` before it, including when the menu is already closed.

**Context.** `MentionableInput` calls it from its `selectionchange` listener and from `handleInput`. React usually skips a write of the value already held, but not straight after the component rendered, when it renders the component once more and bails out.

**Investigation.** Seen 2026-11-05 in happy-dom only, in 5960's investigation: a draft write in `AgentNativeTab.render-count.test.tsx`'s harness committed a `nested-update` from these two writes, because happy-dom dispatches `selectionchange` during the commit. In Chromium, `selectionchange` is queued, and 20 typed characters gave 22 updates and 22 nested updates, every nested one from `react-virtuoso` (task 1), so these writes added no commit there. Caret moves without typing (arrow keys, clicks) were not measured.

**Decisions.**

- **What to do about it?**
  - **Leave it unless a Chromium measurement of caret moves shows a cost (recommended).**
    - Pros: no change for a cost not seen in a real browser.
    - Cons: the happy-dom harness keeps a nested update on draft writes that a reader may mistake for task 1's.
  - **Skip the writes when the menu is already closed and the query empty.**
    - Pros: removes the happy-dom nested update and any bail-out render on a caret move.
    - Cons: `handleCursorChange` must then depend on `isMenuOpen`, so its identity changes when the menu opens or closes, and `MentionableInput` re-subscribes its `selectionchange` listener each time.

## Assumptions and decisions

### Re-check before starting (tasks 1 and 2)

The finding still held on `41f9eb638`, after E12 (#1852), C-0390 (#1854) and C10 (#1851): 50 writes gave 52 `update` and 52 `nested-update` commits per tab, and `transcriptHeader`, `footer`, `emptyState`, `renderMessage`, `computeItemKey` and `itemContent` were still built inline. `messageActions` was already stable in the controller: a conditional on a `useCallback`, so it needed no change.

### Stable inputs alone are not enough (task 1)

The recommended option was to make every input stable, and to reject memoising the element on its own. Both are needed. The library's effect has no dependency list, so it republishes on every render of `<Virtuoso>` even when each prop is the same. `VirtualizedMessageList` therefore renders `memo(Virtuoso)`, and stable inputs are what let that memo hold. A `memo` compares every prop, so unlike a hand-written `useMemo` of the element it cannot miss one.

Inputs the analysis did not list also had to be stable: the status label and the transcript cards from the controller, the resume click that `emptyState` reads, the overscan object, which a focused row rebuilt on every render (`useRatchetedOverscan`), and the inline `style` and `increaseViewportBy`. Other callers of the list keep passing inline props and behave as before.

### What it saves (task 1)

Chromium, development React, 1600 by 900, a 100-row fixture and a fake `invoke`, per tab per 50 writes. Two runs of five batches each, alternating unmodified and changed code, after warming up with 100 writes.

| Tabs | Code | `update` commits | `nested-update` commits | Mean `update` | Mean `nested-update` | Total |
| --- | --- | --- | --- | --- | --- | --- |
| One | Before | 50 | 50 | 3.96 ms | 1.58 ms | 277 ms |
| One | After | 51.6 | 0 | 4.37 ms | none | 226 ms |
| Two | Before | 50 | 50 | 1.74 ms | 0.87 ms | 130 ms |
| Two | After | 51.65 | 0 | 2.48 ms | none | 128 ms |

Plainly: the nested update is gone, which saves about 1 ms per render with one tab under development React and nothing measurable with two, because each remaining `update` commit got slower by 0.4 to 0.7 ms. That slowdown was not attributed. This fits E12's finding that these fixes make little visible difference at this fixture size. What is reliably gained is that a nested update now means a real row change. A trace of the commits over 50 writes, run three times, found no commit that rendered a `TranscriptRow` or the footer, where before each nested commit rendered them. The extra commit or two are empty and take 0 ms. Production React was not measured.

### Keeping rows correct (task 1)

`e2e/TranscriptListRenders.spec.ts` counts nested updates and checks that rows follow find, highlight, expansion, actions, footer status, the header, the previous message, streaming and a hidden tab's return. Five of its tests fail on the unmodified code. To check that it catches a missed dependency, 11 dependencies were removed one at a time. Nine failed the spec straight away. `messages` in `itemContent` is hidden on Codex, because the fork plan rebuilds `renderMessage` whenever messages change, so the spec also runs a Cursor tab, and that catches it. `isLoading` in the footer is hidden because a running turn also changes its clock, so `NativeChatShell.test.tsx` covers it alone. Lint's `react-hooks/exhaustive-deps` also reports both as errors.

### Caret moves (task 2)

Left as it is, the recommended option. With the same fixture, 30 arrow keys and 20 clicks in the composer gave 0 commits both before and after task 1, over 6 batches of each. A temporary counter in the controller, since removed, saw 2 renders over 30 arrow keys and 2 over 20 clicks, in an earlier fixture whose fake backend caused a commit of its own on each read. So there is no render per move. Skipping the writes would make `handleCursorChange` depend on `isMenuOpen` and re-subscribe `MentionableInput`'s listener for no cost seen in a real browser. The spec holds this with a caret-move test.

### Found along the way

- [6620](../transcripts-and-observation/6620-first-find-stops-short.md): the first find on a freshly opened long transcript can stop short of its match. It reproduces without this change. The spec works around it.
- Flake [6621](../../tests/flaky-tests/native-agents-and-transcripts/6621-virtuoso-follow-small-wheel-release.md): a `VirtuosoFollow` test fails about half the time alone, on unmodified code too.

## Constraints and rationale

Measure in Chromium with a fixture transcript and a fake backend: no provider turn. The renderer store work (E12) may change how the controller renders; do task 1 with it or after it rather than before, so the memoisation is not written twice.

## Related

- `5580-agent-native-tab-environment-subscription.md` (deleted 2026-11-06), which removed the renders caused by unrelated environment writes

## Replaces

- 5960 native tab render churn, task 2: its problem, measurements and options are carried here. Task 1 was done in the same change. The deleted file is at `ba209e5b1`.
