# Component browser suite fails on `main` in settings, project list and Cursor close retention

## Task analysis

Analysed 2026-11-02 against main at `fd679c0e2`.

### Tasks

1. **Log Detail shows a `terminal` area**: open.
2. **Merged project list group drags never start**: open.
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

### 2. Merged project list group drags never start

**Problem.** `e2e/MergedProjectList.spec.ts:168` (`project project and group drags ignore expanded environment rows` and `repository project and group drags ignore expanded environment rows`) fails on both viewports. After the first project drag succeeds, the second `hoverDrag` presses the folder handle (`Collapse folder Work`, or the `Open team-a/shared/app on …` repository header) and moves 10 px, but the handle never gets `aria-pressed="true"`; the locator reports the attribute as absent.

**Context.** The sidebar's dnd-kit pointer sensor activates after 8 px (`HierarchicalSidebar.tsx`), so a 10 px move should start the drag. The most recent sidebar change on `main` is `0412ae2c4` (Unify federated sidebar behavior).

**Investigation.** Reproduced on detached `origin/main` at `fd679c0e2` (same command, `e2e/MergedProjectList.spec.ts`): both cases fail on mobile and desktop with retries; the other cases in the file pass. Cause not established.

**Decisions.**

- **Where to start?**
  - **Bisect the sidebar commits since the test last passed (recommended).**
    - Pros: finds the change that stopped the second drag activating.
    - Cons: needs several browser runs.
  - **Rewrite the helper to wait for `aria-pressed` with a longer move.**
    - Pros: quick.
    - Cons: may hide a real regression in dragging folders and repository groups.

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

## Related

- [2920-upstream-pool-idle-test-accept-race.md](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md), the default-suite failure on `main` found in the same validation.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md).
