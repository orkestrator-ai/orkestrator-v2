# Reviewer session models arrive in a different order

- **ID:** 0239
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `build pipeline multi-model review > fans out to every reviewer, consolidates, then addresses the merged report`
- **Owning file:** `apps/backend/src/core/build-pipeline-review-fanout.test.ts:716`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Expected reviewer session models `[opus, sonnet]`; received `[sonnet, opus]` (69.42 ms).
- **Suite counts:** Backend: 7,983 passed, 39 skipped, 2 failed across 434 files (299.03 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-fanout-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-review-fanout.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (2.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Hypothesis:** The assertion compares the insertion order of asynchronously admitted reviewer sessions. The observed reversal suggests completion order can differ from configured reviewer order; no implementation change or deterministic reproduction was attempted.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
