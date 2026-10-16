# Historic tool row has no tool buttons after a long-session append under load

- **ID:** 0253
- **Status:** open
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
