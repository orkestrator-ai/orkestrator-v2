# Structural HTML keeps custom element text (apps/desktop/tests/browser-preview-annotation-script.test.ts)

- **ID:** 0780
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `bounded, sanitized evidence > structural HTML drops handlers, values, scripts, srcdoc, javascript: URLs, and token parameters` (`apps/desktop/tests/browser-preview-annotation-script.test.ts:349`)
- **Original command:** `mise run test:logged -- --name desktop-cap -- bun test --cwd apps/desktop browser-preview preload-api --parallel=4 --only-failures`
- **Worker configuration:** `--parallel=4` (implies `--isolate`), 14 files
- **Failure:** `expect(html).toContain("<custom-widget>Widget</custom-widget>")`; the received structural HTML ended in `<custom-widget></custom-widget></div><!-- truncated -->`, so the custom element's text was dropped and the evidence was cut at its bound (duration: 37.63 ms)
- **Suite counts:** 213 total, 212 passed, 1 failed
- **Isolated rerun:** `bun test tests/browser-preview-annotation-script.test.ts` from `apps/desktop` → 28 passed. The same parallel group then passed three times in a row.
- **Context:** Seen on the 0043 known-limitations branch, which does not change `browser-preview-annotation-script.ts` or this test file.
- **Hypothesis:** The structural HTML walk in `browser-preview-anchor-script.ts` spends a traversal budget that also checks a wall-clock deadline every 32 visits (`spend`). The received HTML stops exactly before the custom element's text node and ends in `<!-- truncated -->`, which is what an exhausted budget produces. Under four parallel workers the deadline likely elapsed mid-walk. Not yet reproduced on demand; a fix would make the test's budget deadline generous (or inject the clock) rather than loosen the assertion.

## Triage 2026-10-25

- **Disposition:** open. This case now also covers [0791](0791-annotation-semantic-context-budget.md) (duplicate).
- **Evidence:** both failures come from the anchor script's wall-clock budgets: `createBudget` deadlines of 5 to 25 ms (`browser-preview-anchor-script.ts:187`, checked in `spend` at line 195). When `now()` passes the deadline, the HTML walk truncates (this case) or the resolver returns `too-complex` (0791: `page-side anchor resolver > a reordered card resolves by surrounding context, not by its old structural position`, 2026-10-24 aggregate, passed alone in 0.4 s). The owner passed alone today (28/28, 0.9 s; Bun 1.4.4).
- **Next step:** let tests inject `now` (or scale the deadlines) so the budgets run out only by visit count; keep the production deadlines.
- **Recurrence (2026-11-01):** in `mise run test` on branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729` based on `066fcb497`, host load averages about 29 to 38: `expect(html).toContain("<custom-widget>Widget</custom-widget>")` failed at `tests/browser-preview-annotation-script.test.ts:352`, the same budget symptom. The owner passed alone, and five more times beside the preview transport owner (`--parallel=2`).
- **Recurrence (2026-11-02):** on branch `shadow-root-annotations-583af4c65646-r1` based on `38d55ee1` (which changes the anchor kit's scope and resolver code but not `sanitizedHtml` or this test), in a focused `--parallel=4` run of ten `browser-preview-*` desktop files on a host running about ten builds: the same truncated `<custom-widget></custom-widget></div><!-- truncated -->` at `tests/browser-preview-annotation-script.test.ts:352` (95.02 ms; 199 passed, 1 failed). The owner passed alone (28/28), and the same ten-file group passed seven times in a row afterwards (200/200 each).

## Investigation — 2026-11-06

The page script's clock is Bun's own process-wide `performance`: inside a
happy-dom `Window`, `window.performance === globalThis.performance`, and a
script run with `window.eval` sees the same object. So the harness
(`apps/desktop/tests/browser-preview-page-harness.ts`) cannot simply freeze
`window.performance.now` per page, as the 2026-10-25 triage suggested: that
would freeze the clock for every test in the worker. A probe that made that
clock advance 2 ms per call did not fail this test (its walk is short enough
to reach only a few deadline checks), so the trigger is a real stall of
25 ms or more between two checks (GC, a descheduled worker), not slow progress.

Fix options, not applied: (1) give the anchor kit a clock the script builders
can set (for example a `now` captured once per capture call from an option
that tests pass), keeping production deadlines; (2) in the harness, replace
the global `performance.now` only for the duration of each synchronous
`eval`/event dispatch and restore it straight after, which needs every direct
`dispatchEvent` in the suites routed through the harness. (1) is cleaner but
changes the page script, so it needs a read of
`docs/architecture/renderer-security.md` first.

## Resolution (2026-11-10)

- **Root cause:** the anchor kit ends each traversal budget on a visit count
  or a wall-clock deadline of 4 to 40 ms (`createBudget`/`spend` in
  `apps/desktop/electron/browser-preview-anchor-script.ts`), and in the
  happy-dom harness its clock is Bun's process-wide `performance`. A real
  stall inside the structural walk (GC, a descheduled worker) spent the 25 ms
  `sanitizedHtml` deadline; the walk's first deadline check falls on its
  24th visit, which in this fixture is the custom element's text node, so the
  evidence ended `<custom-widget></custom-widget></div><!-- truncated -->`.
  The production deadlines are intended; only the test's dependence on them
  was the bug.
- **Fix:** `apps/desktop/tests/browser-preview-page-harness.ts` adds
  `onStoppedClock`, which pins `performance.now` for the synchronous span of a
  page-script call and restores Bun's own descriptor straight after (so the
  page and other tests keep the real clock, and asynchronous continuations
  run on it). The harness's `start`, `status`, `pins`, `click` and `key` run
  on it, so budgets in these suites end only by visit count, which is what
  they assert. The page script, its deadlines and every assertion are
  unchanged; the `too-complex` traversal-budget test still passes, by visit
  count. This also covers duplicate 0791 (resolver `too-complex` through
  `harness.pins`).
- **Reproduced:** yes — a temporary stub made the custom element's
  `hasAttribute("data-orkestrator-annotation-ui")` `Bun.sleepSync(30)`, a real
  stall inside the walks. Unchanged harness:
  `mise run test:logged -- --name b39-0780-repro -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/browser-preview-annotation-script.test.ts --parallel=1 -t "structural HTML drops"`
  failed with exactly the recorded `<custom-widget></custom-widget></div><!-- truncated -->`.
  With the fix and the stall still injected the whole owner passed
  (`b39-0780-fixed-stall`, 28 tests).
- **Stress:** `mise run test:logged -- --name b39-0780-stress -- bun scripts/test-under-contention.ts -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/browser-preview-annotation-script.test.ts --parallel=1 --rerun-each=20`
  passed (exit 0; macOS, burners unpinned). All nine harness users
  (`browser-preview-{annotation-script,pins-live,selection-keyboard,shadow-follow-ups,shadow-targets,shadow-text,source-hints,text-selection}`
  and `source-hint-emitter-doc`) passed with `--parallel=4`
  (`b39-0780-harness-users`), and `bun run --cwd apps/desktop typecheck`
  passed.
