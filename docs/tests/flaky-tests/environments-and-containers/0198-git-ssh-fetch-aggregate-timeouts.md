# Git SSH fetch fixture timeouts

- **ID:** 0198
- **Status:** resolved
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
- **Recurrence (2026-10-24, node mbp3, load average 17 to 38):** a sibling case in the same file, `resolveRemoteWorktreeStartPoint > keeps a configured ssh command and only adds BatchMode`, timed out at 5012.47 ms in the todo-0050 branch's aggregate. The unchanged owner passed alone (18 of 18, 34.5 s). The branch does not touch remote fetch.

## Resolution (2026-11-15)

- **Root cause:** The real `git fetch` cases with configured SSH commands exceeded Bun's 5 s default under aggregate load.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
