# `TerminalContainer` subscribes to the whole environment object

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Select the fields it reads**: stop re-rendering the container for unrelated environment changes. Status: open.

### 1. Select the fields it reads

**Problem.** Any write to this environment record re-renders the terminal container, including fields it never reads.

**Context.** The neighbouring selector already uses `useShallow` (`apps/web/src/components/terminal/TerminalContainer.view.tsx:141-146`).

**Investigation.** The subscription is at `TerminalContainer.view.tsx:168-170`. Fields used include `environmentType`, `setupPhase`, `pendingAgentLaunch`, `worktreePath`, `name` and `startupAgentSession` (`:171-181`, `:686`, `:743-764`). An effect also depends on the whole object (`:771-791`), and `isEnvironmentSetupSettled` takes it whole (`:174`).

**Decisions.**

- **How narrow?**
  - **A `useShallow` selector of the fields read, with the effect and setup check moved onto them (recommended).**
    - Pros: unrelated writes stop re-rendering; matches the code above it.
    - Cons: the effect at `:771` needs careful dependencies, or a launch handoff could run at the wrong moment.
  - **Keep the object, and memoise the heavy children.**
    - Pros: leaves the launch effect alone.
    - Cons: the container's own render stays, and it is a large component.

## Constraints and rationale

The launch handoff must keep firing exactly once. A render-count test in the style of `usePullRequest.render-count.test.tsx` fits this change.

## Needs verification

- How much this costs. The report's confidence is Medium, and no Profiler run has been made.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3

## Outcome

Checked item by item on 2026-11-05 against base commit `69a3b4ca5`. The fix landed in `bfac1f577` (#1754), after this report's analysis at `a2bba9d8`, so this work added tests and the measurement and changed no production code.

No item of this report is left over. One new finding came out of the measurement: with native tabs in the same fixture the subtree still commits on every write (mean 3.5 ms; 4.4 ms with the whole-object subscription), because `AgentNativeTab` selects the whole record. That is another component, so it is to-do [5580](../../todo/cross-cutting/5580-agent-native-tab-environment-subscription.md), not part of this report.

| Item | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| Task 1: Select the fields it reads | No longer holds (fixed in `bfac1f577`) | The whole-object subscription at `:168-170` is gone. `TerminalContainer.view.tsx:160-199` is the recommended `useShallow` selector of the fields read. `reuseUnchangedFields` (`environmentStore.ts`) keeps nested identities, without which `agentSettings` would still re-render. Test: `an unrelated environment field does not re-render the container` and two others in `TerminalContainer.render-count.test.tsx`. Restoring the whole-object subscription fails the first of them. |
| Task 1: move the effect and setup check onto the selected fields | No longer holds (fixed in `bfac1f577`) | The bind effect (`:801-826`) lists the selected fields rather than the object, and `isEnvironmentSetupSettled` runs inside the selector (`:190`), so it still sees all three of its fields. Done here: the test `the setup check still sees a user proceeding past a failed setup`, which fails if `setupOverride` is dropped from the check. |
| Constraints: the launch handoff keeps firing exactly once | Done (test added) | The handoff effect (`:1135-1155`) has the same dependencies as before the fix, and its guard `handedOffSetupFocusRef` is unchanged. Tests: `the launch handoff moves focus once, whatever unrelated writes surround it`, which fails if the guard is removed, and `a provider session binds when published and unrelated writes do not bind it again`, which fails if the effect depends on the whole record or loses `startupProviderSessionId`. Both are in `TerminalContainer.render-count.test.tsx`. |
| Needs verification: how much this costs | Done (measured) | Real `TerminalContainer` in Chromium with development React, `Profiler` around it, a fake backend, two panes with four plain tabs, 200 writes of `lastActivityAt`, two runs each. Whole-object subscription (current code with that one subscription put back): 200 commits, mean 3.5 to 3.7 ms, median 2.1 to 2.2 ms, p95 7.4 to 8.0 ms. Current code: 0 commits. So the cost was a few milliseconds per write and is now none, whatever the size of the tree. The harness was temporary and is not committed. Development React overstates absolute times, and no real backend or production build was run; neither could change the outcome, because the container no longer renders for these writes. |
| Decision: how narrow | Recommended option taken (in `bfac1f577`) | The `useShallow` selector, not memoising children. |
