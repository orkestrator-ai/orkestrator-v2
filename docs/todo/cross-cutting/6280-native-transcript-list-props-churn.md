# The native transcript list re-renders its rows on every render of the tab

## Task analysis

Analysed 2026-11-05 against `main` at `533acf703`, with 5960 task 1 applied. Carried over from [5960](5960-native-tab-render-churn.md) task 2, which found the source of the nested update and recorded why it was not removed there.

### Tasks

1. **Stop re-rendering the list when nothing it shows changed**: give `<Virtuoso>` the same props across a render of the tab that changes nothing in the transcript. Status: open.
2. **No-op file-mention writes on a caret move**: `useFileMentions.handleCursorChange` sets state to the values it already holds. Status: open.

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

## Constraints and rationale

Measure in Chromium with a fixture transcript and a fake backend: no provider turn. The renderer store work (E12) may change how the controller renders; do task 1 with it or after it rather than before, so the memoisation is not written twice.

## Related

- [5580 native tab environment subscription](5580-agent-native-tab-environment-subscription.md), which removed the renders caused by unrelated environment writes

## Replaces

- [5960 native tab render churn](5960-native-tab-render-churn.md) task 2: its problem, measurements and options are carried here.
