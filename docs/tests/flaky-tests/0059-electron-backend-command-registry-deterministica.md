# `Electron backend command registry > deterministically generates refs, diff, Git-object contents, hashes, and validation evidence` (`tests/unit/electron/commands.test.ts`)

- **ID:** 0059
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran with four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** the Git fixture test exhausted Bun's 5,000 ms budget at 5,017.86 ms. Bun then killed two dangling child processes and reported a between-test `git cat-file` command error from the interrupted fixture.
- **Suite counts:** root and agent-support group: 3,657 passed, 1 skipped, 6 failed, and 3 between-test errors across 145 files; the other five failures are the tmux cluster recorded above.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts --parallel 2>&1 | tee /tmp/orkestrator-fix-commands-isolated.log` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 73.77 seconds; the target passed in 1,787.61 ms.
- **Hypothesis:** this case performs several real Git subprocess operations inside one five-second outer budget. It completed in under two seconds when isolated, while the aggregate run was simultaneously timing out other process-heavy backend and tmux tests; no assertion mismatch was observed before the timeout.
