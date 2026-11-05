# Coordinator panel re-render cost

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Measure, then narrow subscriptions**: confirm the cost, then select only what the panel needs and memoize props. Status: open.

### 1. Measure, then narrow subscriptions

**Problem.** A status change anywhere re-renders the panel, and that reaches the transcript controller in every group.

**Context.** The Work panel added more app-wide inputs, and it needs some of them: it re-derives rows from environments, pipelines, reviews and nodes.

**Investigation.** The panel subscribes to the whole `environments` array, `pipelines` and `workflows` (`CoordinatorPanel.tsx:522-524`), though it uses environment names only in the banner (`:1045-1048`). `useCoordinatorWorkItems.ts:90-96` subscribes again, plus portal `nodes`. `AgentNativeTab` is memoized (`AgentNativeTab.tsx:81`), and an inline `data={{…}}` and a fresh `onAssignPlatform` and `beforeSend` defeat that (`CoordinatorPanel.tsx:785-790`, `:808-816`). `CoordinatorPaneTree` documents that it does not memoize its context, because the page recreates the render props (`CoordinatorPaneTree.tsx:168-177`). The controller is 4,302 lines. No render count was measured.

**Decisions.**

- **Where to cut first?**
  - **Move the work derivation and panel into a child that owns those subscriptions, and memoize `data` per conversation (recommended).**
    - Pros: the transcript stops re-rendering for Work panel changes; few lines.
    - Cons: the prompts banner shares `workEnvironmentIds`, so that goes with it.
  - **Rewrite the pane tree's render props as stable components.**
    - Pros: fixes the root cause in the context.
    - Cons: a bigger change with no measurement behind it yet.

## Needs verification

The render cost itself. Profile a busy host before changing anything: this rates low until it is measured.

## Related

- [Coordinator report, 4.4 (U12)](../2026-10-27-coordinator.md#44-ui-and-ux)

## Outcome

Built on branch `coordinator-panel-performance-a9308cd4ef09-r1`, based on
`main` at `1c2f12837`, in commit `26e18dad5`. Checked back item by item on
2026-11-05.

**Findings re-checked against current code.** All still held before the
change. `CoordinatorPanel.tsx` subscribed to the whole `environments` array,
`pipelines` and Multi Review `workflows` (then `:217-219`), and used
environment names only for the banner; `useCoordinatorWorkItems.ts:90-96`
subscribed again, plus portal `nodes`. `useCoordinatorActiveTurn.ts:86` also
subscribed to the whole `environments` array, which the report did not name.
After #1835 and #1851 the inline `data={{…}}`, `onAssignPlatform` and
`beforeSend` had moved into `CoordinatorConversationPane.tsx`, together with
inline `composerHint`, `unassignedIntro` and `emptyPlatformsAction` elements,
so `AgentNativeTab`'s `memo` never held. `CoordinatorPaneTree.tsx` still
documents that its context is not memoized. The controller,
`AgentNativeTab.controller.tsx`, is now 4,456 lines.

**Method.** E12's method: a component-browser fixture (the `e2e/fixture`
Vite server, headless Chromium, React development build, `StrictMode`) with a
fake backend installed as `window.orkestrator`, and React's `Profiler`. The
real `CoordinatorPanel` held three conversations in three groups (one split
twice), each a real `AgentNativeTab` with a 40-row fixture transcript, plus 31
environments, one of them a worker. Profilers wrapped the panel and, inside
`AgentNativeTab`, the transcript controller. Each window made 50 writes, one
per animation frame: an unrelated environment's status, a build pipeline, a
Multi Review, the worker environment's name (which the Work panel does read),
and a refreshed project list (a panel render that changes no conversation's
inputs). No provider turn and no backend process. Three runs per variant. The
fixture, the spec and both Profilers were temporary and are not committed.

| Write (50 per window) | Before: panel commits, time | Before: controller commits per pane, time (3 panes) | After: panel commits, time | After: controller commits per pane, time (3 panes) |
| --- | --- | --- | --- | --- |
| Unrelated environment | 106, 573–590 ms | 102, 271–284 ms | 56, 80–96 ms | 2, 22–35 ms |
| Build pipeline | 106, 524–559 ms | 102, 243–267 ms | 56, 80 ms | 2, 22–23 ms |
| Multi Review | 106, 453–458 ms | 102, 197–198 ms | 56, 76–79 ms | 2, 21–22 ms |
| Worker environment (Work panel row) | 106, 454–481 ms | 102, 197–214 ms | 56, 76–81 ms | 2, 20–23 ms |
| Refreshed project list | 106, 436–498 ms | 102, 186–218 ms | 56, 342–348 ms | 2, 5 ms |

Six panel commits and two controller commits per pane happen in every window
whatever is written: the tabs' own background renders. So before, each write
committed the panel twice and every group's controller twice (about 9–12 ms
of panel time per write, half of it in the controllers); after, a write
commits the Work area once and no controller. Moving the subscriptions alone
(measured before the props were memoized) already gave the first four rows;
the refreshed project list still committed every controller twice per write
until the props were memoized. The panel looked the same before and after
(byte-identical screenshots of the fixture). Production React and a real
host's write rate were not measured; the commit counts do not depend on
either.

**Decision.** The cost shows, so the report's recommended option was taken.

- **Move the work derivation, Work panel and prompts banner into a child
  that owns those subscriptions, and memoize the tab's props per
  conversation (chosen).** Pros: no controller commits for app-wide writes, a
  sixth of the panel time, a small change with no layout change. Cons: one
  more component, and the pane's hooks now run before its empty-state return.
- **Rewrite the pane tree's render props as stable components.** Pros: would
  also stop the pane tree re-rendering on the panel's own renders. Cons: a
  bigger change, and the measurement shows it is not needed: with the props
  memoized, a panel render that changes no conversation's inputs commits no
  controller. Not done, and no to-do: nothing measured asks for it.
- **Change nothing.** Pros: no risk. Cons: every status change on the host
  rendered every open coordinator transcript twice.

| Task | Outcome |
| --- | --- |
| 1. Measure, then narrow subscriptions: measure | Done: numbers above, with the method. |
| 1. Measure, then narrow subscriptions: move the work derivation and panel into a child that owns those subscriptions (with the prompts banner) | Done: `CoordinatorWorkArea.tsx` owns the environment, pipeline, Multi Review and node subscriptions, the prompts banner, the Work panel and the next-wake line, with the conversation groups as its `children`; `CoordinatorPanel.tsx` no longer subscribes to them. `useCoordinatorActiveTurn.ts` selects only the project's home environment ids. Tested in `CoordinatorPanel.render-cost.test.tsx` (unrelated environment, pipeline and Multi Review writes render no conversation; the Work panel and the prompts banner still follow a write to the worker's environment) and `useCoordinatorActiveTurn.test.tsx` (another environment's write renders nothing; a new project home is followed). Both fail on the code before the change. |
| 1. Measure, then narrow subscriptions: memoize `data` per conversation | Done, with the tab's other props: `data`, `onAssignPlatform` and `beforeSend` are memoized, and the composer hint, starter prompts, intro card and settings button are built once (`CoordinatorConversationPane.tsx`). Tested in `CoordinatorPanel.render-cost.test.tsx` (a refreshed project list renders no conversation), which also checks the real `AgentNativeTab` is a `memo` component. |
| Decision option: rewrite the pane tree's render props | Not needed: the smaller cut removed every controller commit the measurement found. |
| Needs verification: the render cost | Done: measured with the fixture above, before and after. |

Every item is implemented, so no to-do was needed.
