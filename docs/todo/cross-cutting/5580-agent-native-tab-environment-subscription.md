# The native agent tab subscribes to the whole environment object

Found while measuring efficiency report part `0650` (WEB-16, batch E-0650). That report covered only `TerminalContainer`, which is fixed, so this is new work rather than a task carried over. The report file was deleted when E-0650 was closed; it is in Git history at base commit `69a3b4ca5`.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **Select the fields the native tab reads**: stop re-rendering the native agent tab for environment fields it never reads. Status: open.

### 1. Select the fields the native tab reads

**Problem.** Every write to an environment record re-renders that environment's native agent tabs, including writes to fields they never read, such as `lastActivityAt`.

**Context.** `TerminalContainer` had the same problem and now selects its fields (`TerminalContainer.view.tsx:160-199`), so a write no longer starts at the container. The store already keeps the identity of unchanged nested values (`reuseUnchangedFields`, `environmentStore.ts`), so `agentSettings` is safe to select directly.

**Investigation.** Two components under the tab select the whole record: `AgentNativeTab.controller.tsx:358` and `AgentNativeTab.helpers.tsx:443`. The controller reads `projectId`, `setupPhase`, `worktreePath`, `pendingAgentLaunch`, `startupAgentSession` and `initialPrompt`, and passes the whole record to `resolvedPlatformSettings` (`:365`). The composer helper reads `worktreePath`, `projectId`, `agentSettings`, `environmentType` and `networkAccessMode`, and passes the record to `resolvedDefaultAgent` (`:477`) and on at `:491` and `:1039`.

Measured on 2026-11-05 in Chromium with development React, using a temporary `Profiler` around the real `TerminalContainer` in a fixture with a fake backend, two panes, and 200 writes of `lastActivityAt`. With four plain tabs there were 0 commits. With two visible native tabs and two plain tabs there were 200 commits, a mean of 3.5 ms each (p95 5.1 ms) in two runs. The tabs were empty, because the fake backend never answers their session reads, so a tab holding a real transcript was not measured. Pinning the commits on these two selectors is by elimination: they are the whole-record selectors that plain tabs do not mount, and neither was changed on its own to confirm it.

**Decisions.**

- **How narrow?**
  - **A `useShallow` selector of the fields read in each component, passing `{ agentSettings }` to the settings resolvers as `agentSettingsTiers` does at `TerminalContainer.view.tsx:210` (recommended).**
    - Pros: unrelated writes stop re-rendering the tab; matches the container's fix and its render-count test.
    - Cons: the controller's startup and initial-prompt reads (`:704`, `:881-892`) need careful dependencies, or a launch could act at the wrong moment.
  - **Keep the record, and memoise the heavy children.**
    - Pros: leaves the startup reads alone.
    - Cons: the controller's own render stays, and it is over 3,000 lines.

## Constraints and rationale

Startup and initial-prompt behaviour must not change. A render-count test in the style of `TerminalContainer.render-count.test.tsx` fits this change.

## Needs verification

- How much this costs with a long transcript. Only empty tabs were measured, and a fixture transcript would be enough, with no provider turn.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 3, which records the container's fix
