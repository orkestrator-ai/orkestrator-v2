# `process and platform command behavior > launches browser, file manager, and editors without a shell` (`tests/unit/electron/commands-process-coverage.test.ts`)

- **ID:** 0108
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/ork-fix-root-tests.log` on an 18-worker macOS host
- **Failure:** the test exceeded Bun's 5,000 ms budget (reported duration 5,002.42 ms) with no assertion message.
- **Suite counts:** root group 3,634 passed, 1 skipped, 4 failed, 3 errors across 143 files in 237.95 s.
- **Isolated rerun:** `bun test ./tests/unit/electron/commands-process-coverage.test.ts --parallel` -> 59 passed, 0 failed in 1.30 s; the whole file costs a fraction of this one test's aggregate budget. Evidence: `/tmp/ork-fix-process-isolated.log`.
- **Recurrence:** the same test also timed out at 5,004.51 ms in the preceding aggregate run at commit `cb520049`, so unlike the `tmux-backend.test.ts` entry above this one has repeated identically across two runs.
- **Recurrence (session-liveness review, 2026-08-14):** timed out again at 5,000.87 ms under `set -o pipefail; bun test ./tests --parallel` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host. Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 errors across 143 files in 212.53 s. The immediate isolated rerun passed all 59 tests. That is three identical timeouts across three separate aggregate runs, which strengthens the contention reading rather than an intermittent one. Evidence: `/tmp/rev-root-tests.log`, `/tmp/rev-isolated-commands-process-coverage.log`.
- **Hypothesis (not confirmed):** the test asserts that browser/file-manager/editor launches happen without a shell, so it waits on spawned child processes; under a loaded 18-worker run those spawns are contending with every other suite's children. The 1.30 s isolated cost makes an outright hang unlikely. Whether the wait is on process spawn or on a fake-binary lookup has not been established.
- **Clean rerun of the whole group:** a later `bun test ./tests --parallel` on the same host and branch reported 3,638 passed, 1 skipped, 0 failed in 118.36 s — half the wall time of the failing run (237.95 s) and with this test passing, which is consistent with contention rather than a defect in the test.
- **Next step:** instrument which awaited spawn is outstanding at timeout before changing the budget, since a raised budget would hide a genuine spawn regression here.
- **Related recurrence (2026-08-27):** the sibling `falls back to the parent
  directory when Linux FileManager1 fails` timed out at 5,001.17 ms in the
  four-worker root suite, left a dangling `xdg-open`, and passed in the combined
  117-test isolated rerun. Its assertions already name both expected launcher
  invocations, so it now carries an explicit outer budget while retaining the
  exact spawn sequence.
