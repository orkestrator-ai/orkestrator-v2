# Component browser suite fails on `main` in settings, project list and Cursor close retention

## Task analysis

Analysed 2026-11-02 against main at `fd679c0e2`.

### Tasks

1. **Log Detail shows a `terminal` area**: done (2026-11-03): `terminal` is a deliberate live-policy area; the spec now expects it and still excludes `web.*` and `terminal.*`.
2. **Merged project list group drags never start**: done (2026-11-03): the previous drag's card took the press; it no longer takes pointer input.
3. **Cursor close-retention cases compare prompts without the appended system instructions**: done (2026-11-03; see Assumptions and decisions).

### 1. Log Detail shows a `terminal` area

**Problem.** `e2e/GlobalSettings.spec.ts:3` (`Log Detail offers only areas controlled by live policy`) fails on both viewports. The locator `combobox` named `/^Log level for (web\.|terminal(?:\.|$))/` resolves to one element, `Log level for terminal`, where the test expects none.

**Context.** The test pins the rule that Settings › Debug › Levels by area lists only areas the live logging policy controls, and that renderer (`web.*`) and terminal areas stay out. The shared-logger migrations (`21201efc7`, `0ec784293`, `82598d869`) changed which areas exist and where they are registered. The error-context snapshot also lists `gateway.terminal`, which the test's regex does not match.

**Investigation.** Reproduced on a detached `origin/main` at `fd679c0e2` with `ORKESTRATOR_E2E_PORT=1489 bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts`: it failed on mobile and desktop, with retries. The terminology branch (`rename-environment-kinds-fbee095fc40a-r1`) fails the same way. Which commit made `terminal` a live-policy area was not established.

**Decisions.**

- **Which side is wrong?**
  - **Check whether `terminal` is meant to be live-controlled, then fix the side that is wrong (recommended).** If the backend now owns a real `terminal` area under live policy, update the test's exclusion; if the area leaked in from a vocabulary list, drop it from the Levels list.
    - Pros: keeps the rule the test pins and fixes the right side.
    - Cons: needs a look at the logging docs (`docs/architecture/logging.md`) before choosing.
  - **Loosen the regex to drop `terminal`.**
    - Pros: one-line change.
    - Cons: may hide a real control that does nothing.

**Outcome.** The spec was wrong. `logDetailAreas()` (`packages/protocol/src/log-policy.ts`) skips only `web.*` and `terminal.*` sub-areas, because their levels come from `orkestrator:debug` at renderer startup; the bare `terminal` area also has backend sites, which follow live policy. `log-policy.test.ts` already asserts that `terminal` is offered. The spec now lists `terminal` among the areas it expects and excludes `/^Log level for (web\.|terminal\.)/`. See Assumptions and decisions.

### 2. Merged project list group drags never start

**Problem.** `e2e/MergedProjectList.spec.ts:168` (`project project and group drags ignore expanded environment rows` and `repository project and group drags ignore expanded environment rows`) fails on both viewports. After the first project drag succeeds, the second `hoverDrag` presses the folder handle (`Collapse folder Work`, or the `Open team-a/shared/app on …` repository header) and moves 10 px, but the handle never gets `aria-pressed="true"`; the locator reports the attribute as absent.

**Context.** The sidebar's dnd-kit pointer sensor activates after 8 px (`HierarchicalSidebar.tsx`), so a 10 px move should start the drag. The most recent sidebar change on `main` is `0412ae2c4` (Unify federated sidebar behavior).

**Investigation.** Reproduced on detached `origin/main` at `fd679c0e2` (same command, `e2e/MergedProjectList.spec.ts`): both cases fail on mobile and desktop with retries; the other cases in the file pass. Cause not established.

Re-checked 2026-11-03 against `main` at `7b48c23fb`: still fails, all four cases. With a 1.5 s pause before the second drag all four pass, so the cause is timing, not the handle. `document.elementFromPoint` at the second press is the first drag's card (`data-testid="sidebar-drag-overlay"`), not the folder handle. After a drop, dnd-kit's `DragOverlay` keeps the card on screen for its drop animation (250 ms by default) while the card slides back to the dropped row. The card took pointer input, so a press on whatever row it covered landed on the card, and that row's drag (or click) never started.

The cause is `0412ae2c4` (#1603, Unify federated sidebar behavior). It added `SidebarDragOverlay` to `MergedProjectList` and `RemoteMachineTree`, which drew no card before. This window's own tree (`HierarchicalSidebar.tsx`) already had a card and the same latent defect. No `DndContext` activation guard blocked the press: `activeRef` is cleared on drop (`@dnd-kit/core` 6.3.1).

**Decisions.**

- **Where to start?**
  - **Bisect the sidebar commits since the test last passed (recommended).**
    - Pros: finds the change that stopped the second drag activating.
    - Cons: needs several browser runs.
  - **Rewrite the helper to wait for `aria-pressed` with a longer move.**
    - Pros: quick.
    - Cons: may hide a real regression in dragging folders and repository groups.

**Outcome.** Fixed in the product: `SidebarDragOverlay` passes `className="pointer-events-none"` to `DragOverlay`, so the card never takes a press, in every sidebar list. The spec's assertion is unchanged. `sidebar-parity.test.tsx` now asserts the card's class and fails without the fix. See Assumptions and decisions.

### 3. Cursor close-retention cases compare prompts without the appended system instructions

**Problem.** Four Cursor cases in `e2e/CloseRetention.spec.ts` fail on desktop (lines 328, 422, 693 and 801). The fixture vendor records each Cursor prompt with an `<orkestrator-system-instructions>` block appended (the Markdown-image and `docs/` guidance), so `prompts` never equals `["Remember the lighthouse …"]`, and `.find((a) => a.prompts.includes(first))` finds nothing.

**Context.** `ec08062d8` (#1521) added `bridges/cursor-bridge/src/system-instructions.ts`, which appends those instructions to Cursor prompts. The fixture keeps recording the exact prompt text it receives; the spec still compares against the user's text alone.

**Investigation.** Reproduced on detached `origin/main` at `fd679c0e2` (same command, `e2e/CloseRetention.spec.ts`): the same four Cursor cases fail; no other platform's case in the file fails.

**Decisions.**

- **How should the test match prompts?**
  - **Strip the system-instructions block in the fixture vendor before recording (recommended).**
    - Pros: one change covers every Cursor case; the spec keeps asserting on the user's text.
    - Cons: the fixture no longer shows that the instructions were sent; add one assertion that they were.
  - **Match by prefix in each spec assertion.**
    - Pros: no fixture change.
    - Cons: four call sites, and `includes` comparisons need rewriting.

## Assumptions and decisions

### Task 1: fix the spec, not the settings list (2026-11-03)

Checked against `main` at `b68b6e710`. The code side is deliberate: the comment in `logDetailAreas()` says the shared `terminal` area has backend sites that follow live policy, and `log-policy.test.ts` asserts `terminal` is offered while every `web.*` and `terminal.*` area is not. Options considered:

- **Change the spec (chosen).** The exclusion regex becomes `/^Log level for (web\.|terminal\.)/` and `terminal` joins the expected-present list. The spec still pins the rule: with the `terminal.` skip removed from `logDetailAreas()` it fails (`terminal.setup` appears, count 1), and with the `web.` skip removed it fails (count 26). Both checks were run locally and not committed.
- **Drop `terminal` from the Levels list.** This would remove a control that does change the backend's terminal logging, and contradict `log-policy.test.ts`.
- **Only loosen the regex.** Passes, but no longer proves the `terminal` control is there.

`gateway.terminal`, also in the failure's snapshot, is a backend area and is correctly offered; the regex never matched it.

### Task 2: fix the product, not the spec (2026-11-03)

The spec is right: two drags one after the other are a real user path, and a press on a row must start that row's drag. The card is purely visual. dnd-kit's sensors listen on the document, and `sidebarCollisionDetection` works from rects, not hit-testing. So `pointer-events-none` on the `DragOverlay` costs nothing during a drag. Options considered:

- **`pointer-events-none` on the shared card (chosen).** One line in `SidebarDragOverlay.tsx`. It fixes the merged lists, another machine's tree and this window's tree together, and leaves the drop animation as it is.
- **Turn off the drop animation (`dropAnimation={null}`).** This also removes the window, but it changes how every drop looks, and a press during any future overlay transition would still be lost.
- **Wait in the spec until the card is gone.** This makes the spec pass but hides a defect a quick user hits: a second drag or a click within 250 ms of a drop is swallowed.

The same run found `e2e/MergedProjectList.spec.ts:43` (`… opens the first shown fallback workspace without dragging`) failing on `main` on both viewports. The cause is test drift: `a4e6c3087` (#1624) made a repository heading with no command-node copy open the leaf's coordinator (`boardTab: "coordinator"`) and updated `project-landing.test.tsx` to expect that, but not this spec. The spec now expects the same intent, so the whole file passes.

### Task 3: where the frame is stripped, and the steering case's second cause

Rechecked on 2026-11-03 against `main` at `7b48c23fb`: the four desktop Cursor
cases still failed (Cursor-only desktop run: 2 passed, 4 failed). The bridge's
frame now comes from `cursorPromptText` in `bridges/cursor-bridge/src/prompt.ts`
(`system-instructions.ts` no longer exists).

- **Stripped in the fake engine, not the host's view.** The fixture vendor is
  `bridges/cursor-bridge/src/testing/fake-engine-server.ts`. Each stored turn's
  `prompt` is now the user's text (`stripSystemInstructions` from
  `@orkestrator/protocol/review-evidence-frames`), and a new `sent` field keeps
  the exact text the SDK was given. History replay (`listRuns`) still returns
  `sent`, as the real vendor would, so the bridge's own strip on reload stays
  exercised. The `Answer to:` reply and the `list` summary use the stripped
  text. Stripping only in the host's `/vendor` view would have left the
  framed text in every reply the page shows.
- **One assertion proves the frame is still sent.** The `/vendor` view exposes
  `sent` per Cursor agent, and the line 328 case asserts the first turn's `sent`
  is the user's text, a blank line, then a complete
  `<orkestrator-system-instructions>` frame.
- **The steering case had a second, independent cause.** With the frame fixed it
  still missed `agent-runtime-steer-saturated`. The fixture fills the steer
  history at the bridge, so the backend sees it only after its cached runtime
  health (`INTERACTIVE_RUNTIME_METADATA_TTL_MS`, 30 s) expires; the card
  appeared 31.1 s after the panel opened. Options: raise that deadline to cover
  the TTL (taken: one line, keeps what the case asserts, costs up to 30 s of
  test time); have the backend refresh runtime health when the panel opens or
  after a steer refusal (a product change outside this task, though a panel
  that lags 30 s behind the bridge is arguably worth a to-do of its own); or
  saturate through the backend (the fixture has no backend route for 1,024
  steers). The deadline is now 60 s, with the reason in a comment. Flake
  [0963](../../tests/flaky-tests/web-ui/0963-close-retention-cursor-cases-under-load.md)
  records both causes; its separate `no running turn to steer` mode stays open.
- **Verified on the final tree (head `08e817a45`).** On beelink, beside other
  builds' Docker network churn, the Cursor-only desktop run failed twice from
  `net::ERR_NETWORK_CHANGED` module loads after `page.reload()` (flake
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md#2026-11-03-a-private-network-namespace-avoids-it)).
  Run in a private loopback-only network namespace (`unshare -rn`), all six
  Cursor cases passed (51.3 s), and so did the whole file in both projects
  (71.6 s).

## Related

- [2920-upstream-pool-idle-test-accept-race.md](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md), the default-suite failure on `main` found in the same validation.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md).
