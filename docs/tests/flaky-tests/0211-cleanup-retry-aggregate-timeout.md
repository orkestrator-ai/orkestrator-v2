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

## Recurrence during main merge validation — 2026-10-15

- **Test:** `persists safe cleanup failure details and permits a backend
  deletion retry` exceeded its 5,000 ms deadline at 7,277.24 ms.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** the documented GNU-tool PATH with
  `mise run test:logged -- --name commands-integration-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 47.2 seconds.
- **Disposition:** aggregate-only deadline failures recorded without changing
  assertions, deadlines or skips. Host contention is a hypothesis, not a proven
  cause.
