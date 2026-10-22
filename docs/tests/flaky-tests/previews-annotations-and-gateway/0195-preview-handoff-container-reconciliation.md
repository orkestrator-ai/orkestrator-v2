# Preview handoff races container reconciliation

- **ID:** 0195
- **Status:** resolved
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

## Resolution (2026-10-17)

The test's own ordering caused it. The first command in the test
(`update_preview_settings`) runs `runtime.init()`, which schedules a background
reconcile of environment `a`. That reconcile seeds the generated `app` service
and resolves it, inspecting Docker. The test installed the fake container only
after the command returned. When the reconcile reached the inspection first,
the resolver cached the `"missing"` result for `inspectCacheMs` (1.5 s,
`preview-target-resolver.ts`). `settle()` and the handoff's `refresh` then
reused it and reported `environment-stopped`. In production a container
exists before its environment is reported running, and a lifecycle change
invalidates the cache, so this is not a product defect.

Adding `await harness.runtime.registry.settle()` straight after
`update_preview_settings`, before the container is installed, reproduced the
exact failure every time. The test now installs the container before the
first command, so no inspection can run before it exists (the harness never
initializes the runtime on its own).

- Stress, eight concurrent processes running the owning file with
  `--rerun-each 25`: 1,200 of 1,200 passed.
