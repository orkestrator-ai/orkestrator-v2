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
