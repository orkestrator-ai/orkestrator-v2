# Git SSH fetch fixture timeouts

- **ID:** 0198
- **Status:** open
- **Date observed:** 2026-10-12
- **Tests:** `SSH command precedence and argument contracts > preserves simple arguments through a real Git SSH fetch` and `keeps a quoted OpenSSH executable and its configured arguments`
- **File:** `apps/backend/src/core/commands-files-remote-fetch.test.ts`
- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test`, using the GNU-tool PATH from the testing guide.
- **Worker configuration:** workspace 2, root 3, bridges 2, protocol 1.
- **Failure:** Five-second fixture timeouts (5005.26 ms and 5004.32 ms), with a following unhandled command failure.
- **Suite counts:** Backend package 5,840 passed, 15 skipped, 4 failed across 328 files.
- **Isolated rerun:** `mise run test:logged -- --name isolate-remote-fetch -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-files-remote-fetch.test.ts --parallel=1 --only-failures` passed, exit 0, in 12.6 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.tUZZDC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** Process or fixture scheduling during the concurrent aggregate may exhaust the test budget. The isolated pass supports an aggregate-only failure but does not establish a root cause. No assertion, timeout or skip was changed.
