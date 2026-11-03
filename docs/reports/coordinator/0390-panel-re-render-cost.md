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
