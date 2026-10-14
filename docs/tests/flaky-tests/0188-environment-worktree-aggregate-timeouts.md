# Local worktree Git operations time out in the aggregate

- **ID:** 0188
- **Status:** open
- **Date observed:** 2026-10-11
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`.
- **Original command:** `mise run test:logged -- --name full-frozen -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** root `--parallel=3`; other aggregate groups and an isolated browser suite were active.
- **Failures:** `Electron backend environment lifecycle commands > suffixes local worktree branches when origin has an unfetched branch with the stored name` timed out at 5011.76 ms; `creates local worktrees from a configured remote default branch` timed out at 5038.36 ms. Both have a 5000 ms deadline. Pending Git-fixture operations also rejected after timeout cleanup.
- **Root group:** 5003 passed, 24 skipped, 3 failed and 2 errors across 253 files in 149.42 seconds. The third failure was flake-registry metadata formatting, corrected and verified separately.
- **Evidence:** `/tmp/orkestrator-test-run.G96aSV/root-and-agent-support-tests.log` (compressed after the aggregate finishes).
- **Isolated rerun:** `mise run test:logged -- --name lifecycle-isolation -- bun test ./apps/backend/tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed (exit 0, 16.9 seconds).
- **Hypothesis:** competing process and Git/worktree fixture activity delayed the cases beyond their deadlines. The isolated pass supports a load-sensitive timeout without establishing which individual operation stalled. No timeout was raised and no test was skipped or loosened.
