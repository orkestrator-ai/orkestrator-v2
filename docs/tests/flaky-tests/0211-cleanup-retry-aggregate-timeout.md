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

## Recurrence on 2026-10-15

The OpenCode model-selection validation aggregate reproduced this unchanged
test's timeout after 7450.55 ms against the default 5000 ms deadline. The same
owning file also timed out in `deletes an environment only after all three local
server kinds exit` after 5559.99 ms.

The unchanged owning file passed alone in 38.1 seconds:

```bash
mise run test:logged -- --name command-integration-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No assertions or deadlines were changed.

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

## Recurrence — 2026-10-15 (coordinator mail branch merge)

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name merge-repository-tests -- mise run test`
timed out the same cleanup-retry test at 5870.46 ms against its 5000 ms
limit. The aggregate reserved 4/1/2/1 workspace/root/bridge/protocol slots,
with two concurrent workspace package tasks and two backend Bun workers.
Backend results were 7,903 passed, 39 skipped and one failed across 433 files
(331.16 seconds); the aggregate finished in 435.9 seconds. Root separately
hit the Pi staging timeout tracked in 0178; bridges and protocol passed.
Evidence:
`/tmp/orkestrator-test-run.XSWXem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

After the aggregate and the Pi isolated rerun finished, the same GNU-tool PATH
with
`mise run test:logged -- --name merge-cleanup-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 24.1 seconds. Host contention
remains an unconfirmed hypothesis. No timeout, assertion or skip was changed.

## Recurrence during Multi Review validation diagnostics (2026-10-16)

- While the aggregate was active, `mise run test:logged -- --name commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` timed out in the unchanged cleanup-retry case at 6750.13 ms. The file reported 52 passed and three timeouts in 127.9 seconds.
- After the aggregate finished, the same owning-file command with `--name commands-integration-final-rerun` passed unchanged in 32.1 seconds (exit 0).
- Evidence: `/tmp/orkestrator-test-run.3kSG12/commands-integration-rerun.log.gz`. No cleanup implementation, assertion, timeout or skip changed; host contention remains a hypothesis.

## Recurrence — 2026-10-16 (gateway terminal fallback backoff)

`mise run test` on `feat/gateway-terminal-fallback-backoff`, which changed no
backend code, timed out this unchanged test at 7473.73 ms against its 5000 ms
limit while other worktrees ran suites on the host. Backend results were 8,085
passed, 40 skipped and 3 failed across 438 files (324.01 seconds); the other
failures are case 0248 and the deterministic provider line-limit check.
Evidence:
`/tmp/orkestrator-test-run.3Pp4em/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name backend-cmd-integration-file -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file in 32.3 seconds. No timeout, assertion or skip
was changed.
