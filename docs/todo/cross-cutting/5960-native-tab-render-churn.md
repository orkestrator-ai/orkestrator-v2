# Each render of the native agent tab does avoidable work

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`, with 5580 applied. Re-checked and built 2026-11-05 against `main` at `533acf703` (5580 merged as #1830): both findings still held. `submit` is now at `AgentNativeTab.controller.tsx:1932` and the opening-prompt effect at `:2909`.

### Tasks

1. **Stabilise `submit`**: stop the send callback changing on every render without losing the opening prompt's retry. Status: done (2026-11-05).
2. **Find the nested update**: identify what commits a second time on each render of a tab with a platform. Status: done (2026-11-05): the source is `react-virtuoso`'s prop sync; removing it moved to [6280](6280-native-transcript-list-props-churn.md).

### 1. Stabilise `submit`

**Problem.** `submit` in `AgentNativeTab.controller.tsx:1928` gets a new identity on every render, so everything depending on it re-runs, including the opening-prompt effect at `:2899`.

**Context.** `useUserCommands` returns `refresh: () => refreshRef.current()`, a new function each call (`hooks/useUserCommands.ts:76`), and `refreshUserCommands` is in `submit`'s dependencies (`:2500`). A comment at `:1943` says a refused opening prompt is "retried by the caller once the turn ends and this callback changes", so the effect's retry leans on `submit` changing.

**Investigation.** Instrumenting `submit`'s dependencies on 2026-11-05 showed `refreshUserCommands` as the one that changed on every render. Not all of `submit`'s refusals are visible in its dependencies: three read refs (`queueEditPendingRef`, `submitInFlightRef`, `beforeSendPendingRef`), and `isSubmitting`, `preparingSend` and `queueEditPending` release them. Today any of those renders wakes the effect only because the callback is unstable. No misbehaviour has been seen from the churn.

**Decisions.**

- **How to stabilise it?**
  - **Memoise `refresh` and give the effect those three states as explicit dependencies, with a test for each refusal being retried (recommended).**
    - Pros: fixes the churn at its source and makes the retry's wake-ups visible rather than accidental.
    - Cons: touches the launch path, so each refusal needs its own test.
  - **Memoise `refresh` only.**
    - Pros: one line.
    - Cons: a prompt refused on a ref alone could then wait until the turn state next changes, or never be sent.
  - **Leave it.**
    - Pros: no risk to launches.
    - Cons: the retry keeps depending on an accident, and any later memoisation can break it unnoticed.

### 2. Find the nested update

**Problem.** Each render of a tab with a platform commits twice: the update, then a `nested-update`, which is a state write from a layout effect.

**Context.** The unassigned composer does not do this: it committed once per write in the 5580 measurement.

**Investigation.** Measured on 2026-11-05 in Chromium with development React and a 100-row fixture: the update took about 2.6 ms and the nested update about 0.9 ms with one tab, and about 4.7 ms and 1.2 ms for two tabs together. The source was not identified. Start with `VirtualizedMessageList` and other child components that can schedule state updates from layout effects. The controller's only `useLayoutEffect` assigns `forkPlanRef.current`; that ref write cannot schedule a nested update and is an eliminated lead. `NativeChatShell`'s dock measurement only sets state when the height changes, so it should not be the cause.

**Decisions.**

- **What to do about it?**
  - **Find the source with a temporary `Profiler` and decide from what it is (recommended).**
    - Pros: cheap, and a state write that changes nothing may be a one-line fix.
    - Cons: may find a measurement that has to stay.
  - **Leave it.**
    - Pros: about 1 ms per render under development React is small.
    - Cons: it is paid on every streamed frame of every visible tab.

## Assumptions and decisions

### Task 1: the recommended option, as specified

`useUserCommands` now returns a `refresh` memoised with `useCallback` (`hooks/useUserCommands.ts:78`); it reads `refreshRef`, so it still calls the current tab's reader after a tab change. The opening-prompt effect lists `isSubmitting`, `preparingSend` and `queueEditPending` as dependencies, with a comment saying why. The comment on the `noQueue` refusal now names `canQueue` as what changes `submit` once the turn ends.

The re-check found that only one of the three explicit dependencies is load-bearing today. `sendLocked` (`:1595`), already one of `submit`'s dependencies, includes `queueEditPending` and `isSubmitting`, so releasing those two changes `submit` anyway. `preparingSend` is in no dependency of `submit`, so a prompt refused during a pre-send check (`beforeSend`) was retried only because `submit` changed on every render. All three are listed anyway, as recommended, so the retry does not depend on what `sendLocked` happens to contain.

Tests, in `AgentNativeTab.render-count.test.tsx` because it already pins startup and initial-prompt behaviour:

- `a render that changes none of the send's inputs does not re-run the opening-prompt effect`: a backend-owned launch calls `clearTabInitialPrompt` on every run of the effect, so the test counts those calls across a `worktreePath` write that renders the tab. It fails with the unmemoised `refresh`.
- `an opening prompt refused during a pre-send check is sent once the check ends` (`beforeSendPendingRef`), `... during another send is sent once that send ends` (`submitInFlightRef`, a held `!` command that then fails) and `... during a queue edit is sent once the edit ends` (`queueEditPendingRef`, a held queue removal that then fails). Each checks the prompt is not sent while the refusal holds, is sent once released, and is sent exactly once. Removing `preparingSend` from the effect fails the first; the other two pass without their dependency because of `sendLocked`, as above.
- `refresh keeps its identity across renders and reads for the current tab` in `hooks/useUserCommands.test.tsx`.

The observable for `submit`'s identity is the effect's re-runs rather than the callback itself: no child receives `submit` directly (the composer gets inline handlers), and a test-only export from the controller would add surface for one assertion.

### Task 2: the source is react-virtuoso's prop sync

Found with a temporary React DevTools commit hook (it recorded which fibers each commit rendered and, through React's updater tracking, the stack that scheduled each update) and a temporary `Profiler`, both removed before committing, in two harnesses:

- **Chromium**, development React, Vite serving a temporary `e2e/fixture` page with one or two real `AgentNativeTab`s at 1600 by 900 over a fake `invoke` serving a 100-row fixture transcript (user prompts alternating with markdown, code and tool-call replies), and 50 writes to the environment's `initialPrompt` 40 ms apart, a field the controller selects. Every write committed an `update` and then a `nested-update`. Each nested update was scheduled from `react-virtuoso` 4.18.19's `systemToComponent`: a layout effect with no dependency list that republishes every prop into the list's internal store on each render of `<Virtuoso>` (toggling `propsReady` too). Its `useSyncExternalStore` subscribers then force a synchronous re-render, about seven per commit. The nested commit renders the visible `TranscriptRow`s (11 here) and the list footer.
- **happy-dom**, `AgentNativeTab.render-count.test.tsx`'s harness, which replaces the virtualizer. Environment writes gave no nested update there. A draft write did, from a different source: `MentionableInput`'s `selectionchange` listener calls `useFileMentions.handleCursorChange`, which sets `isMenuOpen` and `searchQuery` (`hooks/useFileMentions.ts:117-118`) to the values they already hold. happy-dom dispatches `selectionchange` during the commit; Chromium queues it, and in Chromium those writes were batched into the keystroke's own update, adding no commit (20 keystrokes gave 22 updates and 22 nested updates, the nested ones again from `react-virtuoso`). It is recorded in 6280 as a lead and not changed here.

Commit counts, the same before and after this work because the source was not changed:

| Tabs holding the fixture | Writes | `update` commits | `nested-update` commits | Mean `update` | Mean `nested-update` |
| --- | --- | --- | --- | --- | --- |
| One | 50 | 52 | 52 | 6.7 to 7.9 ms | 1.6 to 1.8 ms |
| Two | 50 | 54 | 54 | 10.5 to 10.7 ms | 2.1 to 2.2 ms |

The two commits beyond the 50 writes in each row are the tab's own reads settling. Ranges are two runs.

It is not a state write that changes nothing, and it is not one line to fix. The republish is how `react-virtuoso` delivers props to its internals, and the controller and `NativeChatShell` pass `<Virtuoso>` new `itemContent`, `computeItemKey` and `context` on every render, because `renderMessage`, `header`, `footer`, `emptyState` and the controller's `messageActions` and `transcriptHeader` are built inline. On a render that changes what the list shows (a streamed frame), the nested commit is where the rows update, so that work stays. On a render that changes nothing the list shows, such as the environment write measured here, the nested commit is avoidable, but only by making all of those inputs stable across three components, which risks rows that stop updating. A throwaway check that memoised the `<Virtuoso>` element on `messages` alone (wrong in general, and reverted at once) left 2 nested updates with one tab and 5 with two, from the tab's start-up, against 52 and 54. Its render times were noisy and are not used. That work is [6280](6280-native-transcript-list-props-churn.md).

### Task 2: Remove the ref-only layout effect as an investigation target

The controller's effect updates a ref without scheduling React state. Keep it as an eliminated lead and investigate child components with state-writing layout effects instead. The source of the measured nested update remains open; this correction does not claim to identify it.

## Constraints and rationale

Found while measuring [5580](5580-agent-native-tab-environment-subscription.md). That work removed the renders caused by unrelated environment writes; these two costs remain on every render the tab still has, such as a streaming transcript.

Startup and initial-prompt behaviour must not change; `AgentNativeTab.render-count.test.tsx` pins it. Anything measured needs a fixture transcript and no provider turn.

## Related

- [5580 native tab environment subscription](5580-agent-native-tab-environment-subscription.md)
- [6280 native transcript list props churn](6280-native-transcript-list-props-churn.md), what task 2 left

## Outcome

| Task | Outcome |
| --- | --- |
| 1. Stabilise `submit` | Done. `refresh` is memoised (`apps/web/src/hooks/useUserCommands.ts:78`) and the opening-prompt effect lists `isSubmitting`, `preparingSend` and `queueEditPending` (`AgentNativeTab.controller.tsx:2909`). Tests: the four opening-prompt cases in `AgentNativeTab.render-count.test.tsx` (identity across an unrelated render, and a retry after each of `beforeSendPendingRef`, `submitInFlightRef` and `queueEditPendingRef`) and `refresh keeps its identity across renders and reads for the current tab` in `useUserCommands.test.tsx`. |
| 2. Find the nested update | Source found and recorded: `react-virtuoso`'s `systemToComponent` republishes every prop in a dependency-less layout effect on each render of `<Virtuoso>`, whose inputs are rebuilt on every render of the tab. 52 updates and 52 nested updates for 50 writes with one tab, unchanged by this work. Not a no-op state write, so not fixed here; stabilising the list's inputs moved to a to-do: [6280](6280-native-transcript-list-props-churn.md). |
