# Backend cleanup retry exceeds the aggregate deadline

- **ID:** 0211
- **Status:** open

Observed: 2026-10-14

- Test: `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry`
- Owner: `apps/backend/tests/commands-integration.test.ts` (was `tests/unit/electron/commands-integration.test.ts` when observed)
- Original command: `mise run test:logged -- --name full-tests -- mise run test`
- Worker configuration: three root Bun workers, alongside workspace, bridge and protocol groups and other host validations.
- Failure: default 5000ms timeout, observed duration 6336.21ms.
- Root result: 5043 pass, 24 skip, 6 fail in 197.16 seconds. Five other failures involved macOS shell-tool prerequisites; validation was restarted with the documented GNU tool path.
- Evidence: `/tmp/orkestrator-test-run.H9WZ9L/root-and-agent-support-tests.log.gz`.
- Isolated rerun: documented GNU `PATH`, then `mise run test:logged -- --name cleanup-isolated -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures`; unchanged owning file passed in 35.0 seconds.

Hypothesis: process cleanup, worktree inspection and fixture I/O were delayed by concurrent host load. Warnings about intentionally injected cleanup failures are expected in this test. No assertions or deadlines were loosened.
