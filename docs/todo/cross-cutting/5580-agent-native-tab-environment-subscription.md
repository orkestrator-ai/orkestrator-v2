# The native agent tab subscribes to the whole environment object

Found while measuring efficiency report part `0650` (WEB-16, batch E-0650). That report covered only `TerminalContainer`, which is fixed, so this is new work rather than a task carried over. The report file was deleted when E-0650 was closed; it is in Git history at base commit `69a3b4ca5`.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Re-checked and built 2026-11-05 against `main` at `6e796ca32`: the selectors, the line references and the recommended option all still held.

### Tasks

1. **Select the fields the native tab reads**: stop re-rendering the native agent tab for environment fields it never reads. Status: done (2026-11-05).

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

## Current state

`SharedNativeAgentController` and `UnassignedNativeAgentComposer` each select the fields they read with `useShallow` and pass `{ agentSettings }` to the settings resolvers. `AgentNativeTab.render-count.test.tsx` pins the result.

Measured 2026-11-05 in Chromium with development React: a temporary `Profiler` around two real `AgentNativeTab`s side by side at 1600 by 900, a fake backend serving the fixture transcript, and 200 writes of `lastActivityAt`, each run three times. Fixture rows alternate a short user prompt with an assistant reply of markdown, a code block and a tool call. "Render per write" is the Profiler's `actualDuration` summed and divided by the writes, averaged over the runs. "Wall per write" is the whole write loop divided by the writes, so it also holds about 4.7 ms of the loop's own timer wait; only the difference means anything.

| Two tabs holding | Commits before | Commits after | Render per write before | Render per write after | Wall per write before | Wall per write after |
| --- | --- | --- | --- | --- | --- | --- |
| Empty transcript | 400 | 0 | 2.00 ms | 0 | 5.34 ms | 4.82 ms |
| 100 rows | 400 | 0 | 2.40 ms | 0 | 5.67 ms | 4.76 ms |
| 1000 rows | 400 | 0 | 2.57 ms | 0 | 5.71 ms | 4.67 ms |
| Unassigned composer | 200 | 0 | 1.94 ms | 0 | 5.32 ms | 4.82 ms |

A long transcript adds little: 1000 rows cost about 0.6 ms per write more than an empty tab across the two tabs, because the list renders only the visible rows (8 in the DOM here). So the cost is small per write and scales with writes and open tabs, not with transcript length, and the file's Low rating was right.

These two selectors were the cause. Changing each alone, on the same harness, moved only its own path, and the two never run in one tab because the composer mounts only before a platform is chosen:

| Selectors narrowed | Commits, tabs with a platform (any row count) | Commits, unassigned composer |
| --- | --- | --- |
| Neither | 400 | 200 |
| Controller only | 0 | 200 |
| Composer only | 400 | 0 |
| Both | 0 | 0 |

## Constraints and rationale

Startup and initial-prompt behaviour must not change. A render-count test in the style of `TerminalContainer.render-count.test.tsx` fits this change.

## Assumptions and decisions

### Task 1: derived booleans for the startup session

The controller selects `hasStartupAgentSession` and `startupAgentFailed` rather than `startupAgentSession` or its status, because it asks only whether the session exists and whether it failed. Selecting the object would have re-rendered the tab when the backend published `providerSessionId` or moved the status from starting to running, neither of which it reads. `TerminalContainer` already handles those for the tab.

### Task 1: the opening-prompt effect no longer re-runs on environment writes

The startup effect at `AgentNativeTab.controller.tsx:2899` depends on `submit`, and `submit` changes on every render because `useUserCommands` returns a new `refresh` each time. Before this change every environment write therefore re-ran the effect, which is also what could retry an opening prompt refused earlier. That accidental wake-up is gone. No launch relied on it: every refusal in `submit` is released by a state change that renders the tab anyway (`setIsSubmitting`, `setPreparingSend`, `setQueueEditPending`, or the turn state behind `canQueue`), and `never queues an opening prompt behind a running turn` in `AgentNativeTab.test.tsx` still passes with no environment write. 5960 recorded the unstable callback, which has since been memoised (5960 task 1, done 2026-11-05; the file is in Git history at `ba209e5b1`).

### Task 1: proving behaviour unchanged

The new test file was also run against the old selectors. Its 20 cases that do not count commits passed, and the 5 that failed did so only at `expect(commits).toBe(0)`, so the startup and initial-prompt cases describe both versions. Deliberately breaking each new selector field in turn failed at least one case every time.

### Task 1: measurement harness not committed

The harness was temporary, as the first measurement's was, and only the numbers and method are kept here. The render-count test holds the result, so a committed browser fixture would add upkeep without catching anything more. Production React was not measured.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 3, which records the container's fix
- [6280 native transcript list props churn](6280-native-transcript-list-props-churn.md), what is left of the two costs this measurement found on the renders that remain (5960, done and deleted; in Git history at `ba209e5b1`)
