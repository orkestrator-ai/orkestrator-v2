# Service preview spec times out waiting for the window title

- **ID:** 2399
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** the `beforeAll` of `e2e/agent-testing/service-preview-electron.spec.ts`,
  reported against `the tunnel is advertised and a service loads through its
  credentialed loopback ingress`.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=session-import mise run test:logged -- --name electron-session-import -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron`,
  on macOS, one worker, on an uncommitted change from `main` at `066fcb497`, with
  the production app and other work running (load average about 10 around that
  time).
- **Failure:** `expect(page).toHaveTitle` expected `Orkestrator AI — DEV
  [service-preview-smoke]` and received `Orkestrator AI` for the full 60 seconds.
  The backend had started and the renderer's document had loaded. No test ran:
  1 failed, 19 did not run.
- **Rerun:** the same command with run ID `session-import-2` passed that stage
  and all 7 tests before an unrelated selector error in a new test, and
  `session-import-3`, after that error was fixed, passed the owning file 20 of 20.
- **Hypothesis (unproven):** a slow or stalled renderer start under host load. The
  title is set by the renderer, so a stall before that point looks like this.
  Nothing recorded in the run shows where it stopped.
- **How to reproduce:** not reproduced; it has been seen once.

## Triage note (2026-11-15)

Not changed. Recorded failure: the window title not updating for 60 s after backend start, in Electron. Electron specs and their configs were not run or edited in this pass (shared with other groups, and unverifiable here); no spec-local explicit signal could be justified without a live reproduction. Stays `open`.

Addendum (2026-11-15): the Electron config's new `expect: { timeout: 30_000 }` does not touch this failure, which was the spec's own 60 s title wait. Stays `open`.
