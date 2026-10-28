# Idle-observation live spec reads a retired sidebar marker

Checked against `main` at `930189337` (2026-10-26). Task 1 done on
2026-10-28 against `main` at `6a6009a09`.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Read the marker's `data-state`**: replace the colour-class probe in `sidebarActivity` and `sidebarActivityFromClass`, and its unit test. Status: done (2026-10-28).
2. **Rerun the live spec**: run `idle-observation-live.spec.ts` live and confirm the sidebar cases see real states, recording budgets in 0049. Status: open (task 1 landed; needs a credentialed live session, see Qualification).

### 1. Read the marker's `data-state`

**Problem.** The live idle-observation spec reads the sidebar through an `svg.shrink-0.transition-colors` element that no longer exists, so every read is `unknown`. Its sidebar `expect.poll` waits time out, and its "sidebar never showed working" check passes without looking. Only maintainers running the opt-in live spec are affected; no product behaviour is wrong.

**Context.** The marker became `EnvironmentStatusMarker` on 2026-10-24, a day after the spec landed (#1182, `e498ff5b`). The problem was found while writing `container-claude-terminal-signal.spec.ts` for 0020, whose own `sidebarActivity` reads `data-state` and works. The file's constraint prefers `data-state` over colours, because the colours are a design choice and have already changed once.

**Investigation.** The description is still accurate at HEAD. `e2e/agent-testing/idle-observation-live.spec.ts:361` walks up from the label span to an `svg.shrink-0.transition-colors` (`:368`, `:371`) and passes its class to `sidebarActivityFromClass` (`e2e/agent-testing/idle-observation-live-support.ts:101`), which still maps `text-blue-500`, `text-amber-500`, `text-success` and `text-muted-foreground`. Its test pins those strings (`idle-observation-live-support.test.ts:44`). The marker renders `data-testid="environment-status-marker"` with `data-state` (`apps/web/src/components/environments/EnvironmentStatusMarker.tsx:40`, `:42`). `EnvironmentItem.tsx:557` passes `inactive` for a stopped environment, otherwise the agent activity (`idle | working | waiting`, `packages/protocol/src/agent-activity.ts:12`). The working example is `e2e/agent-testing/container-claude-terminal-signal.spec.ts:130`, which uses the same label walk. The spec's call sites compare only against `idle`, `waiting` and `working` (`:716`, `:780`, `:1039`, `:1253`, `:1307`, `:1366`, `:1406`); nothing reads `stopped`, so mapping `inactive` to `stopped` only matters for the timeline strings. An unnoticed effect: the missed-final case at `:716` sets `sidebarIdleAt` only on `idle`, so with every read `unknown` that case cannot finish its sidebar wait either.

**Done (2026-10-28).**

- `e2e/agent-testing/idle-observation-live-support.ts` replaces `sidebarActivityFromClass` with `sidebarActivityFromMarkerState` (`working`, `waiting` and `idle` pass through, `inactive` becomes `stopped`, anything else is `unknown`) and adds `environmentMarkerState`. That function runs in the page. For each `span[id]` label with the environment's name, it looks only inside that label's own `role="button"` region, returns the first marker's `data-state` it finds, and otherwise returns null. So a same-named label outside a row (a pane title, say) is skipped.
- `e2e/agent-testing/sidebar-activity.ts` exports the one `sidebarActivity(page, environmentName)`. Both `idle-observation-live.spec.ts` and `container-claude-terminal-signal.spec.ts` import it; their own copies are gone.
- The old walk climbed ancestors until one contained *any* marker. A row showing a spinner (starting, stopping, deleting) has no marker, so it could have reported a neighbour's state. The bounded walk reads `unknown` there.
- The detach case's "the sidebar never shows working on an idle tab" check no longer passes blind. It also requires at least one `idle` reading during the wait, and it records the set of readings in the case notes.
- Tests: the colour-class unit test is now a `data-state` mapping test (`idle-observation-live-support.test.ts`). A new "live-spec sidebar probe" block in `tests/unit/components/EnvironmentItem.test.tsx` runs the probe against real rendered rows: working, waiting, idle, stopped, absent, a stopping row beside a working one, and a same-named label outside any row. A fixture spec, `e2e/SidebarActivityProbe.spec.ts`, runs `sidebarActivity` through Playwright's serialisation against the real row in the settings-drawer fixture. Before the same-named-label refinement, a mutation check showed both unit tests failing when the probe was swapped back to the retired `svg` selector, or allowed to walk past the row.
- No web change was needed. The marker already exposes `data-state`, and `EnvironmentStatusMarker.test.tsx:42` pins it for every state.
- `docs/development/agent-testing.md` (the inactive-environment traps) now says to read sidebar activity from `data-state` through this helper.

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

## Current state

- Found on 2026-10-26 while writing
  `container-claude-terminal-signal.spec.ts`
  ([0020](../containers-and-environments/0020-container-state-observation.md)):
  its first version copied the old colour-class helper and never saw the
  sidebar show working. Reading `data-state` instead worked at once.
- Fixed in code on 2026-10-28 (task 1 above). Both live specs now share one
  `data-state` reader, and real-row unit and fixture tests guard it.
- Not yet observed live: no credentialed run of
  `idle-observation-live.spec.ts` has happened since the fix (task 2).

## Outstanding work

### Qualification

- Rerun `idle-observation-live.spec.ts` against a live profile and confirm the
  sidebar cases now observe real states. Record any budget results they
  produce in [0049](0049-native-agent-idle-observation.md). The pass criterion
  is in task 2. This needs live Claude and Codex turns, so run it on a host
  that allows them, with a disposable profile, one provider at a time:

  ```bash
  mise run dev:test --profile idleqa-0199 --fixture --credential-source claude \
    --credential-source codex --agent-platforms claude,codex
  # In a second terminal, once dev:status reports ready; then repeat with
  # ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=codex and run id idleqa-0199-codex:
  ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-0199 ORKESTRATOR_AGENT_TEST_RUN_ID=idleqa-0199-claude \
    ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=claude \
    mise run test:logged -- --name idle-observation-live-claude -- \
    mise run test:agent:browser -- e2e/agent-testing/idle-observation-live.spec.ts --workers=1
  mise run dev:stop --profile idleqa-0199
  mise run dev:reset --profile idleqa-0199
  ```

  Check `output/agent-testing/<run>/idle-observation-live/<platform>.json`. A
  pass means the `followUntilQuiet` timelines show `sidebar=working` and then
  `sidebar=idle`, and the detach notes list `idle sidebar readings` without
  `unknown`. If the run is folded into 0049's next session (task 2's
  recommendation), that session's command covers this item instead.

## Assumptions and decisions

### Where the shared reader lives (task 1)

- **Options.** (a) Everything in `idle-observation-live-support.ts`, as the
  analysis recommended. (b) The pure mapping and the in-page DOM function in
  `idle-observation-live-support.ts`, and the Playwright wrapper
  `sidebarActivity(page, name)` in a new `sidebar-activity.ts` beside
  `sidebar-tooltip.ts`. (c) Fix the idle spec inline and leave the container
  spec's copy.
- **Choice: (b).**
- **Pros.** The support module stays pure (no Playwright `Page` value), so its
  unit test and `EnvironmentItem.test.tsx` import the probe without a browser.
  The container spec imports a neutrally named sidebar module, not one named
  for the idle spec. There is still one reader to fix next time.
- **Cons.** One more small file than (a). The DOM function lives in a module
  named for the idle spec. (c) would have been the smallest diff, but it keeps
  the duplicate walk that let this defect happen.

### What replaces `sidebarActivityFromClass` (task 1)

- **Options.** (a) A pure `sidebarActivityFromMarkerState` that maps
  `inactive` to `stopped`, as recommended. (b) Return `data-state` verbatim
  (`inactive` in timelines).
- **Choice: (a).** It returns a typed `SidebarActivity` union.
- **Pros.** A unit test fails if the state vocabulary changes. Timelines keep
  the `stopped` wording of earlier live records.
- **Cons.** The container spec's readings now say `stopped` instead of
  `inactive`. Nothing in that spec compares against either value.

### Bounding the DOM walk to the row (task 1)

- **Options.** (a) Keep the container spec's walk: climb ancestors from the
  label until one contains any marker. (b) Stop at the label's
  `closest('[role="button"]')`, the row's selectable region, which holds both
  the marker and the label. (c) Add a row-level `data-environment-id` in the
  web component and select by it.
- **Choice: (b).**
- **Pros.** It reads only stable semantics (an id'd label, the row's ARIA role,
  the marker's test id and `data-state`), with no classes or colours. A row
  showing a spinner reads `unknown` instead of a neighbour's state. It needs no
  product change.
- **Cons.** It still assumes the label sits inside the row's `role="button"`
  region. `EnvironmentItem.test.tsx` now pins that, so a markup change fails
  the default suite rather than an opt-in live run. (c) would have been more
  explicit, but it adds product markup only tests use, when the marker already
  exposes what is needed.

### Guarding checks that can pass blind (task 1)

- **Options.** (a) Change only the probe. (b) Also require a positive reading
  where a check is purely negative.
- **Choice: (b), for the detach case only.** It is the one purely negative
  sidebar check ("never shows working"). Every other sidebar call site waits
  for a specific state, so a blind probe already fails it by timing out.
- **Pros.** A future blind probe fails the detach case instead of passing it.
- **Cons.** If the sidebar ever legitimately shows neither `idle` nor
  `working` for the whole idle wait, the case now fails and needs triage. The
  case notes record the readings to make that quick.

### Offline evidence in place of a live run (task 2)

- **Options.** (a) Run the live spec here. (b) Defer it, and prove the probe
  offline against real rows: the unit DOM and the fixture browser.
- **Choice: (b).** Live provider runs are not allowed on the host that did
  task 1.
- **Pros.** The probe's DOM contract and its Playwright serialisation are
  proven without credentials or a profile.
- **Cons.** Nothing here shows the live sidebar reaching `working` during a
  real turn; that stays task 2.

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
