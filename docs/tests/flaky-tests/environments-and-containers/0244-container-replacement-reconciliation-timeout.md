# Container replacement reconciliation aggregate timeout

- **ID:** 0244
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `restart reconciliation > a kill at any phase before the commit write leaves the original authoritative`
- **Owning file:** `apps/backend/tests/container-replacement.test.ts`
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name full-tests-host-tools -- mise run test`
- **Worker configuration:** four workspace slots (two package tasks with two Bun workers each), one root worker, two bridge slots, and one protocol slot under the aggregate host-capacity runner.
- **Failure:** five-second outer timeout at 5004.19 ms, followed by an unhandled between-tests assertion at line 385: expected reconciliation result `settled`, received `unreachable`.
- **Suite counts:** backend: 8,063 tests, 8,023 passed, 39 skipped, 1 failed and 1 additional error across 436 files in 418.88 seconds. The aggregate also reported three unrelated firewall fixture timeouts in the root group.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.4v9Bnb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and adjacent `summary.json`.
- **Isolated rerun:** the same GNU-tool PATH prefix with `mise run test:logged -- --name container-replacement-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-replacement.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 5.7 seconds.
- **Hypothesis:** the subprocess-based reconciliation fixture exhausted its outer deadline during aggregate execution. The unchanged owning file passed in isolation; host contention may contribute, but the root cause remains unconfirmed. The change being validated adds account-refresh tests and does not alter container replacement, its fixtures, or their deadlines.
