# Evidence body put has not started at aggregate assertion

- **ID:** 6194
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `evidence ingestion > commits a body's row and acknowledges only after put resolves`
- **File:** `apps/backend/src/core/change-tracking/evidence-body-store.test.ts`
- **Original command:** `cd '.' && mise run test:logged -- --name review-default-tests -- mise run test`, after commit `b3be5f9c1`; backend used `4x PARALLEL`.
- **Failure:** at line 339, `putIds.length` was 0, expected greater than 0 (136.95 ms). A subsequent pull logged `Cannot use a closed database` after test cleanup.
- **Suite counts:** backend 16161 pass, 132 skip, 1 fail; web separately 12942 pass, 3 fail; root 3643 pass, 1 skip, 1 fail.
- **Evidence:** `/tmp/orkestrator-test-run.Riwtch/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer runner `/tmp/orkestrator-test-run.Hp8VEL/review-default-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name fix-evidence-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/evidence-body-store.test.ts --parallel=1 --only-failures` passed (exit 0, 0.3 s).

The aggregate assertion observed the operation before its put callback started. The cause of that scheduling difference is unestablished. The later closed-database error is consistent with cleanup racing outstanding work. Neither this test nor its ingestion implementation was changed by the usage-meter branch. No assertions were weakened.
