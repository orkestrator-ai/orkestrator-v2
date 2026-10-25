# Agent registry snapshots cross a millisecond boundary

- **ID:** 0241
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `AgentRegistry > lists every agent tab and coordinator with live state and counts`
- **Owning file:** `apps/backend/src/core/agent-registry.test.ts:117`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Consecutive snapshots differed only in `generatedAt`, by one millisecond (11.26 ms).
- **Suite counts:** Backend: 7,983 passed, 39 skipped, 2 failed across 434 files (299.03 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-registry-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-registry.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (0.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Hypothesis:** The test compares independently generated snapshots with exact equality, including the wall-clock generation timestamp. A clock boundary between the calls explains the recorded difference.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
