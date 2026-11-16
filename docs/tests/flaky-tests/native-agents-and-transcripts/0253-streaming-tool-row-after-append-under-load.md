# Historic tool row has no tool buttons after a long-session append under load

- **ID:** 0253
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Test:** `[mobile-chromium] › a tool row outside the render window remains reachable after a long-session append`
- **Owning file:** `e2e/StreamingTranscript.spec.ts:114`
- **Original command:** the full component browser suite
  (`bunx playwright test` with `e2e/playwright.config.ts` moved to a free
  port, because another worktree's fixture server held port 1422) on branch
  `mobile-layout-gaps`, while other environments ran test suites on the same
  host.
- **Failure:** after `Scroll to tool history`, `[data-chat-message-index="40"]`
  became visible but held no `Exec Command success` buttons: expected 16,
  received 0 within 5000 ms at line 132.
- **Suite counts:** 261 passed, 64 skipped, 1 failed (1.2 min).
- **Isolated reruns:** the test alone in `mobile-chromium` passed three times
  (1.8 s each), and the whole owning file passed in both projects (12 cases,
  5.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.kv3Ws7/browser-suite.log.gz` and
  its `summary.json`.
- **Hypothesis:** the historic row's tool parts render after a measurement
  pass that a loaded host delays past the 5 s expectation. The change under
  test (stable pane hosts, the app dialog host and the projects drawer
  backdrop) does not touch transcript rendering, measurement or this
  fixture. The related history cases are 0207 and 0238. No assertion was
  skipped or weakened.

## Recurrence — 2026-11-15 (Environment Files review fix)

Desktop `a tool row outside the render window remains reachable after a long-session append` (`e2e/StreamingTranscript.spec.ts:115`) failed in `mise run test:logged -- --name browser -- mise run test:browser`: `distanceFromBottom` did not reach 1 within 5 s at line 119. The same desktop worker also failed three neighbours that have no case of their own: `earlier tool block stays mounted during append` (section and tool, line 54; "Execution context was destroyed, most likely because of a navigation" in `waitForFrames`) and `cold fill keeps the long transcript render window bounded` (line 101; `transcript-row-count` not found while waiting for navigation). They are recorded here rather than in new cases because the four-digit flake numbers are exhausted (9999 is the last claim). The complete owner passed alone in `mise run test:logged -- --name browser-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/HtmlPreview.spec.ts e2e/ToolGroupFold.spec.ts e2e/StreamingTranscript.spec.ts` (no StreamingTranscript failure; 67 passed overall). `mise run flaky:recurrence -- 0253 --base f53768371` answered open.

Branch `environment-files-1d94a340e118-r1` at `8dbbf2872`, base `f53768371`, Linux x86_64, Bun 1.4.4. The branch's only `apps/web` change is one Settings help string in `GlobalSettings.sections.tsx`; it changes no component spec and no Playwright config. No assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** a default Playwright deadline on a loaded host while waiting on a real signal. Playwright's 5 s default assertion deadline expired on the web-first `toHaveCount(16)` for the historic row's tool buttons, a real render signal that a loaded host delayed. The spec passes no smaller timeout at that call (the only explicit `timeout: 1_000` in the file is inside the `toPass` fold retry, not the recorded call).
- **Fix:** `e2e/playwright.config.ts` (the component browser suite, `mise run test:browser`) now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Both are hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced before the fix. The evidence is a rerun of the component specs that had failed in a loaded run, with the new config: 112 passed. A raised budget is weaker evidence than a reproduced race.
- **Reopen:** a recurrence that hangs near the new budget (a navigation near 120 s, an assertion near 30 s) means the signal never arrives; reopen this case rather than raising the budget again.
