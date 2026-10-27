# Idle-observation live spec reads a retired sidebar marker

Checked against `main` at `930189337` (2026-10-26).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Read the marker's `data-state`**: replace the colour-class probe in `sidebarActivity` and `sidebarActivityFromClass`, and its unit test. Status: open.
2. **Rerun the live spec**: run `idle-observation-live.spec.ts` live and confirm the sidebar cases see real states, recording budgets in 0049. Status: open (waits on task 1).

### 1. Read the marker's `data-state`

**Problem.** The live idle-observation spec reads the sidebar through an `svg.shrink-0.transition-colors` element that no longer exists, so every read is `unknown`. Its sidebar `expect.poll` waits time out, and its "sidebar never showed working" check passes without looking. Only maintainers running the opt-in live spec are affected; no product behaviour is wrong.

**Context.** The marker became `EnvironmentStatusMarker` on 2026-10-24, a day after the spec landed (#1182, `e498ff5b`). The problem was found while writing `container-claude-terminal-signal.spec.ts` for 0020, whose own `sidebarActivity` reads `data-state` and works. The file's constraint prefers `data-state` over colours, because the colours are a design choice and have already changed once.

**Investigation.** The description is still accurate at HEAD. `e2e/agent-testing/idle-observation-live.spec.ts:361` walks up from the label span to an `svg.shrink-0.transition-colors` (`:368`, `:371`) and passes its class to `sidebarActivityFromClass` (`e2e/agent-testing/idle-observation-live-support.ts:101`), which still maps `text-blue-500`, `text-amber-500`, `text-success` and `text-muted-foreground`. Its test pins those strings (`idle-observation-live-support.test.ts:44`). The marker renders `data-testid="environment-status-marker"` with `data-state` (`apps/web/src/components/environments/EnvironmentStatusMarker.tsx:40`, `:42`). `EnvironmentItem.tsx:557` passes `inactive` for a stopped environment, otherwise the agent activity (`idle | working | waiting`, `packages/protocol/src/agent-activity.ts:12`). The working example is `e2e/agent-testing/container-claude-terminal-signal.spec.ts:130`, which uses the same label walk. The spec's call sites compare only against `idle`, `waiting` and `working` (`:716`, `:780`, `:1039`, `:1253`, `:1307`, `:1366`, `:1406`); nothing reads `stopped`, so mapping `inactive` to `stopped` only matters for the timeline strings. An unnoticed effect: the missed-final case at `:716` sets `sidebarIdleAt` only on `idle`, so with every read `unknown` that case cannot finish its sidebar wait either.

**Decisions.**

- **Where should the marker reader live?**
  - **A shared helper in `idle-observation-live-support.ts` (recommended).** Export one `sidebarActivity` that reads `data-state`, and have both live specs import it.
    - Pros: one reader to fix next time the marker changes; the container spec's copy goes away; the mapping (`inactive` to `stopped`) can stay unit-tested.
    - Cons: touches 0020's spec as well, which slightly widens the change.
  - **Fix only the idle spec, inline.** Copy the container spec's reader into `idle-observation-live.spec.ts`.
    - Pros: the smallest diff, confined to one spec.
    - Cons: leaves two copies of the same DOM walk, which is how this defect happened.
- **What replaces `sidebarActivityFromClass`?**
  - **A pure `sidebarActivityFromMarkerState(state)` mapping, with an updated unit test (recommended).** Pass through `working`, `waiting` and `idle`, map `inactive` to `stopped`, and return `unknown` otherwise.
    - Pros: keeps a unit test that fails if the state vocabulary changes; matches the spec's existing `stopped` wording.
    - Cons: a thin function that does almost nothing.
  - **Delete it and return `data-state` verbatim.** Use `inactive` in the timeline.
    - Pros: no mapping to maintain.
    - Cons: loses the unit test; earlier live records said `stopped`, so old and new timelines would differ.

### 2. Rerun the live spec

**Problem.** The sidebar half of the idle-observation evidence has been unobservable since 2026-10-24, so any 0049 result taken after that date says nothing about the sidebar.

**Context.** The spec is opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`, `docs/development/agent-testing.md:505`) and is listed in `e2e/agent-testing/playwright.browser.config.ts:43`. It needs live Claude and Codex turns, plus credentials for any other provider it runs. 0049's 2026-10-23 live check predates the marker change, so its sidebar readings were valid.

**Investigation.** No rerun is recorded since the marker change. Any 0049 live case run before task 1 lands would repeat this blind spot. The rerun goes through `mise run test:agent:browser` against a `dev:test` profile, with `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS` narrowing providers.

**Decisions.**

- **How should the rerun be scoped?**
  - **Fold it into the next 0049 live session (recommended).** Land task 1 first, then run the sidebar cases as part of 0049's outstanding live cases.
    - Pros: one credentialed session covers both files; budgets land straight in 0049.
    - Cons: this file stays open until 0049's next live run.
  - **A standalone Claude and Codex rerun now.** Use `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=claude,codex`.
    - Pros: closes this file quickly and confirms the fix itself.
    - Cons: spends a separate live session, and 0049 still has to run its own cases.
- **What counts as a pass?**
  - **Every sidebar poll observes a non-`unknown` state, and the timelines show `working` then `idle` (recommended).**
    - Pros: shows directly that the probe sees the DOM; budget results are a bonus recorded in 0049.
    - Cons: a provider-side budget failure still needs triage in 0049.
  - **The whole spec passes for both providers.**
    - Pros: a single clear signal.
    - Cons: ties this test-only fix to unrelated provider failures already tracked in 0049, such as Claude's background-task output.

`e2e/agent-testing/idle-observation-live.spec.ts` decides what the sidebar
shows (`sidebarActivity`) by finding an `svg.shrink-0.transition-colors` next
to the environment's label and mapping its colour class through
`sidebarActivityFromClass` (`idle-observation-live-support.ts`): blue is
working, amber waiting, `text-success` idle. The environment row's marker is
now `EnvironmentStatusMarker` (`apps/web/src/components/environments/EnvironmentStatusMarker.tsx`,
changed on 2026-10-24, after the spec on 2026-10-23): a `span` with
`data-testid="environment-status-marker"` and `data-state` set to `working`,
`waiting`, `idle` or `inactive`, coloured red and yellow. No `svg` matches,
so every sidebar read returns `unknown`.

## Current state

- Found on 2026-10-26 while writing
  `container-claude-terminal-signal.spec.ts`
  ([0020](../containers-and-environments/0020-container-state-observation.md)):
  its first version copied this helper and never saw the sidebar show
  working. Reading `data-state` instead worked at once.
- In the idle-observation spec this means the `expect.poll` calls on the
  sidebar (the waits for working and for settling) time out, and the checks
  that the sidebar never showed working on an idle tab pass without looking.
  The spec itself was not rerun for this note: it needs live Claude and Codex
  turns (`ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`).

## Outstanding work

### Code

1. Read the marker's `data-state` in `sidebarActivity`, map `inactive` to the
   spec's `stopped`, and replace `sidebarActivityFromClass` and its unit test
   in `idle-observation-live-support.test.ts`. The new spec's
   `sidebarActivity` is a working example.

### Qualification

- Rerun `idle-observation-live.spec.ts` against a live profile and confirm the
  sidebar cases now observe real states (and record any budget results they
  produce in
  [0049](0049-native-agent-idle-observation.md)).

## Constraints and rationale

- Prefer the marker's `data-state` over colour classes: the colours already
  changed once (blue/amber to red/yellow) and are a design choice, while
  `data-state` is what the marker's own tests pin.

## Open questions

None.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md)
  (the qualification this spec serves).
- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md).
