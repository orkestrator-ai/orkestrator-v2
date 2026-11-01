# Service preview paste target gains a stray character

- **ID:** 2393
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `Edit-menu copy and paste reach a service view, and page clipboard
  access stays gated` in `e2e/agent-testing/service-preview-electron.spec.ts`.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=typed-address mise run test:logged -- --name electron-service-preview -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron`,
  on macOS, one worker, on an uncommitted change from `main` at `066fcb497`. The
  Electron window ran on the developer's own desktop, with the production app
  open.
- **Failure:** `expect(received).toBe(expected)` at line 1510. Expected
  `pasted-into-svc-a`, received `pasted-into-svc-at`, unchanged for the 5-second
  poll. The test took 5.4 s. The serial suite then skipped the remaining 10
  tests: 8 passed, 1 failed, 10 did not run.
- **Rerun:** the same command with run ID `typed-address-2`, immediately after
  and with only formatting changed: the owning file passed 19 of 19, this test
  in 0.7 s. Rerunning the single test alone was not tried, because it depends on
  earlier tests in the serial file.
- **Hypothesis (unproven):** the paste itself arrived intact, and one extra
  character followed it in the focused textarea, which suggests a real key event
  rather than a clipboard problem. The window runs on a shared desktop and can
  take focus, so a keystroke meant for another application could land there.
  Nothing recorded in this run shows where the character came from. The test
  added in the same change types `/app/next` into the address bar two tests
  earlier and ends in the same letter, but it uses Playwright's `fill`, which
  sends no key for that text, and the rerun with that test present passed.
- **How to reproduce:** not reproduced; it has been seen once.
