# The shared terminal browser check can start with an empty project sidebar

- **ID:** 10002
- **Status:** open
- **Observed:** 2026-11-19 on `terminal-dimensions-cbc4f770a47d-r1`, base
  `0007f0e669b0f9ac0c1abc215ff466c17c3bfc07`, tested fix `665a5aaa0`.
- **Test:** `the client the user last interacted with sets a shared terminal's size, and both see its output`
- **File:** `e2e/agent-testing/terminal-size-ownership.spec.ts`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=address-size-cbc4f770 ORKESTRATOR_AGENT_TEST_RUN_ID=address-size-cbc4f770-final mise run test:logged -- --name address-size-two-client -- mise run test:agent:browser -- terminal-size-ownership.spec.ts terminal-mobile-panes.spec.ts --workers=1`
- **Configuration:** one headless Chromium worker on Linux, against a disposable
  local dev profile. The component browser suite was running concurrently.
- **Failure:** the desktop sidebar rendered “No projects yet” and the seeded
  project did not appear within 30 seconds, although the setup commands found
  the fixture and started the environment. Playwright reported 1 passed, 1
  failed in 141.2 seconds. Failure capture also exceeded the trace sanitization
  bound. Logged diagnostics were saved at
  `/tmp/orkestrator-test-run.1Q61gf/address-size-two-client.log.gz`.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=address-size-owner-proof ORKESTRATOR_AGENT_TEST_RUN_ID=address-size-owner-proof mise run test:logged -- --name address-size-ownership-only -- mise run test:agent:browser -- terminal-size-ownership.spec.ts --workers=1 --trace off`.
  The owning file passed on the same commit using a fresh disposable profile
  (1 passed, 42.2 seconds for the logged command). Tracing was disabled to
  keep failure capture inside the sanitization bound.
- **Open question:** the fixture was visible through direct backend commands,
  but the desktop sidebar had no projects. The browser's project hydration
  path needs reproduction before attributing this to a missed update or adding
  test synchronization.
