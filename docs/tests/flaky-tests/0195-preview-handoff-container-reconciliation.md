# Preview handoff races container reconciliation

- **ID:** 0195
- **Status:** open
- **Date observed:** 2026-10-12
- **Test:** `preview commands > the iOS handoff URL carries only a one-use session code, never the grant`
- **File:** `apps/backend/src/core/commands-registry-previews.test.ts:93`
- **Original command:** `mise run test:logged -- --name backend-package-tests -- bun run --cwd apps/backend test:workspace`
- **Worker configuration:** Two Bun workers (`--parallel=2`).
- **Failure:** `PreviewServiceError: PreviewError:environment-stopped: The environment's container no longer exists.` (4.63 ms).
- **Suite counts:** 5801 passed, 15 skipped, 2 failed; 5818 tests across 326 files.
- **Isolated rerun:** `mise run test:logged -- --name preview-commands-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-registry-previews.test.ts --parallel=1 --only-failures` → passed, exit 0 (0.2 seconds).
- **Hypothesis:** The test installs the fake container immediately before settling the registry. The failure reports a missing container at attachment creation, suggesting an overlapping reconciliation observed the earlier fake inventory. The available evidence does not identify the exact interleaving.
- **Evidence:** Failure artifact `orkestrator-test-run.wS9yy3/backend-package-tests.log.gz` in the platform temporary directory; passing output was deleted by the logged runner.

No assertion, timeout, or skip was changed.
