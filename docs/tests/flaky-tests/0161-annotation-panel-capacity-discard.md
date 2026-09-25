# annotation panel authoring > a capacity error keeps the note and capture with Retry and Discard

- **ID:** 0161
- **Status:** resolved
- **Date observed:** 2026-09-24
- **File:** `apps/web/src/components/browser/annotations/AnnotationPanel.test.tsx:176`
- **Original command:** `mise run test` (four aggregate groups; web package via
  `test:workspace`, default worker configuration).
- **Failure:** `waitFor` timed out waiting for
  `capture.mocks.discardPendingCapture` to be called with `"cap-1"`
  (1,088 ms, the default `waitFor` budget) after clicking **Discard capture**.
- **Suite counts:** Web: 7,184 tests, 7,171 passed, 2 failed (this test and
  0156) across 338 files (304.11 s). Backend, protocol, desktop and bridges
  groups passed.
- **Isolated rerun:** `bun test ./src/components/browser/annotations/AnnotationPanel.test.tsx`
  from `apps/web` passed (with `DesignCanvasTab.test.tsx`: 18 pass, 0 fail).
- **Context:** Observed while validating backend-only web-annotation changes
  (dispatch/results); no `apps/web` source changed in that change.
- **Hypothesis (superseded):** Under aggregate load the asynchronous discard
  exceeds the one-second default `waitFor` timeout. Disproved: the Discard
  click calls `discardPendingCapture` synchronously (instrumented: one call
  before the click handler returns), so no amount of waiting was involved.
- **Interim mitigation:** `useAnnotationUiTestBudget()` in
  `apps/web/src/test/web-annotation-harness.tsx` raised the per-test and
  `waitFor` budgets (20 s / 5 s). It did not stop the failures (see below).

## Reproduction (2026-09-25)

Run from `apps/web` with 16 busy-loop shell processes on a 12-core host:

- `bun test src/components/browser/annotations/AnnotationPanel.test.tsx -t "capacity error" --rerun-each=25`
  failed 6/25 and 9/25 (with the 20 s / 5 s budget in place). Every failure was
  `findByText(/Not saved: Capacity reached/)` timing out: the panel showed
  "Add a comment to publish this note" instead, and no `draft_save` or
  `asset_stage` call was made. Instrumenting the test showed the textarea's
  value was already `""` immediately after `fireEvent.change(comment, "Too big")`,
  on the same, still-connected element.
- The whole file (`--rerun-each=15`, budget disabled) also failed the first
  test in 8/15 runs, 20–38 s long, followed by "Unhandled error between tests"
  from the overrun test's tail running into the next test's fakes.

## Root causes

1. **Lost keystroke in `useAnnotationDraft` (production bug).** The hook's
   editor-identity effect resets `textRef` to the local copy (or `""`). If a
   keystroke reaches `setText` after the editor committed but before its passive
   effects ran, React flushes that pending effect at the start of the
   keystroke's own render, and the effect wipes the text just typed. Save then
   reads an empty body. Load widens the window between the textarea appearing
   in the DOM (where `findByRole` sees it) and the passive effect flush. The
   recorded symptom (the Discard `waitFor`) was not reproduced; the capacity
   test's reproducible failure was this one, one step earlier.
2. **A failing DOM-identity assertion blocks the event loop for ~30 s (test
   infrastructure).** Bun's `expect` formats a failing value by walking its
   object graph, and a Happy DOM node reaches the whole document and window.
   A single failing `expect(document.activeElement).toBe(textarea)` built a
   400,524,851-character message in 30.8 s *without* CPU load. In
   `waitFor(() => expect(document.activeElement).toBe(comment))`, the fast path
   passes on the first poll; under load the focus effect has not run yet, the
   first poll fails, and the formatter stalls the event loop for 20–50 s
   (instrumented: a 20 ms interval did not fire for 35–50 s; the main thread
   stayed runnable with RSS swinging up to 1.4 GB). That overran every test and
   `waitFor` budget and let the stalled test run into the next test.

## Fix

- `apps/web/src/components/browser/annotations/useAnnotationDraft.ts`: a
  `textKeyRef` records which editor identity `textRef` belongs to. The identity
  effect keeps dirty text already typed into the same editor instead of
  resetting it; switching to a different editor still loads that editor's own
  copy. Regression: "keeps text typed before the editor's identity effect ran
  (flake 0161)" in `useAnnotationDraft.test.tsx` types from a layout effect,
  which lands in exactly that window. It fails deterministically without the fix
  (`Expected: "Typed early"`, `Received: ""`) and passes with it.
- `tests/register-dom.ts`: Happy DOM `Node.prototype` gets a bounded
  `nodejs.util.inspect.custom` description, which Bun's `expect` honours. The
  same failing assertion now formats in 0 ms as
  `Expected: <button aria-label="Add note"> "One"` / `Received: <body> …`. This
  covers every web suite with a `toBe(element)` focus assertion, including
  `AnnotationPanel.flows.test.tsx` (a 29 s aggregate timeout of "narrow layout:
  Add note shows the preview…" had the same shape).
- `useAnnotationUiTestBudget()` is kept as modest headroom (10 s per test,
  2 s per `waitFor`, down from 20 s / 5 s), with its comment updated to say
  it is not the fix.

## Verification (2026-09-25)

- Full `AnnotationPanel.test.tsx`, budget disabled (Bun 5 s / Testing Library
  1 s defaults), 16 CPU burners: `--rerun-each=20` → 280 pass, 0 fail.
- Capacity test alone, 16 burners, `--rerun-each=25` → 25/25 (was 16–19/25).
- `AnnotationPanel.test.tsx` + `AnnotationPanel.flows.test.tsx`, budget
  restored, 16 burners, `--rerun-each=10` → 220 pass, 0 fail.
- `mise run test:logged -- --name panel -- bun --cwd=apps/web test src/components/browser/annotations/AnnotationPanel.test.tsx --rerun-each=20`
  → PASS (40.7 s).
- `mise run test:logged -- --name draft -- bun --cwd=apps/web test src/components/browser/annotations/useAnnotationDraft.test.tsx src/components/browser/annotations/useAnnotationDraft.local.test.tsx --rerun-each=10`
  → PASS.
- `mise run test:logged -- --name annotations-parallel -- bun --cwd=apps/web test src/components/browser/annotations --parallel=3 --only-failures`
  under 32 burners → PASS (31.1 s).
- Annotations directory plus the focus-heavy `BrowserTab`, `AgentRadioGroup`,
  `MentionableInput`, `AgentModelPicker` and `AgentChatFind` suites,
  `--parallel=3` → 304 pass, 0 fail across 18 files.
- `mise run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck` → PASS.
