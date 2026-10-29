# Preview setup-terminal process-root aggregate timeout

- **ID:** 1306
- **Status:** open
- **Date observed:** 2026-10-29 (macOS, Bun 1.4.4).
- **Test:** `preview terminal process roots > the spawned local setup terminal is a managed root until it exits`.
- **Owning file:** `apps/backend/src/core/preview-terminal-roots.test.ts`.
- **Original command:** `mise run test:logged -- --name review-fix-full-tests -- mise run test:full`.
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; the backend used two parallel Bun workers. Groups waited about 533 seconds for host scheduler admission.
- **Failure:** the test timed out at 20,003.12 ms against its 20,000 ms deadline. The aggregate retained no more specific failing await.
- **Backend counts:** 12,955 passed, 123 skipped, one failed across 13,079 tests in 797 files (713.07 s). The full command remained failed on this timeout, the CLI setup-failure scenario, and pre-existing diagnostic-bounds violations.
- **Complete unchanged owner:** `mise run test:logged -- --name review-fix-preview-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-terminal-roots.test.ts --parallel=1 --only-failures` passed (exit 0, 2.9 s).
- **Evidence:** host temporary artifact `orkestrator-test-run.ePdIio/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `orkestrator-test-run.4IEsqs/review-fix-full-tests.log.gz`. The passing logged owner discarded its detailed output.
- **Assessment:** confirmed aggregate-only failure in this run; cause unestablished. Concurrent worktree validation was observed. PTY/process scheduling under contention is a hypothesis, not a diagnosis. No owning implementation, assertion, timeout or skip changed.
- **Next step:** capture which setup completion, PTY termination or fixture cleanup await is pending when the deadline expires.

- **Register repair (2026-10-29):** renumbered from the colliding 1304 to 1306; the original failure evidence and status are unchanged.
