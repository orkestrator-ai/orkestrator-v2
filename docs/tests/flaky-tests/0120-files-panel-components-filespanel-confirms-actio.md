# `Files panel components > FilesPanel confirms actions and keeps failed actions open for retry` (`tests/unit/components/FilesPanel.test.tsx`)

- **ID:** 0120
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/rev-root-tests.log` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host
- **Worker configuration:** Root-only suite, `--parallel` (18 workers), run on its own rather than inside `bun run test`.
- **Failure:** the test exceeded Bun's 5,000 ms budget (reported duration 5,090.23 ms) with no assertion message.
- **Suite counts:** Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 between-test errors across 143 files in 212.53 s.
- **Isolated rerun:** `bun test ./tests/unit/components/FilesPanel.test.tsx --parallel` -> 22 passed, 0 failed, exit 0. Evidence: `/tmp/rev-isolated-filespanel.log`.
- **Hypothesis:** A bare timeout with no assertion text, in a happy-dom component test that drives a confirm-then-retry flow across several awaited state transitions. Nothing establishes which await was outstanding, and the whole owning file costs a fraction of this one test's aggregate budget in isolation, so contention is the leading reading. Instrument the outstanding transition before raising the budget — a raised budget would hide a genuine regression in the retry path.
