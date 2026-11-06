# Evidence body put has not started at aggregate assertion

- **ID:** 6550
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `evidence ingestion > commits a body's row and acknowledges only after put resolves`
- **File:** `apps/backend/src/core/change-tracking/evidence-body-store.test.ts`
- **Original command:** `cd '.' && mise run test:logged -- --name review-default-tests -- mise run test`, after commit `b3be5f9c1`; backend used `4x PARALLEL`.
- **Failure:** at line 339, `putIds.length` was 0, expected greater than 0 (136.95 ms). A subsequent pull logged `Cannot use a closed database` after test cleanup.
- **Suite counts:** backend 16161 pass, 132 skip, 1 fail; web separately 12942 pass, 3 fail; root 3643 pass, 1 skip, 1 fail.
- **Evidence:** `/tmp/orkestrator-test-run.Riwtch/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer runner `/tmp/orkestrator-test-run.Hp8VEL/review-default-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name fix-evidence-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/evidence-body-store.test.ts --parallel=1 --only-failures` passed (exit 0, 0.3 s).

The aggregate assertion observed the operation before its put callback started. The cause of that scheduling difference is unestablished. The later closed-database error is consistent with cleanup racing outstanding work. Neither this test nor its ingestion implementation was changed by the usage-meter branch. No assertions were weakened.

### Resolution — 2026-11-06

- **Root cause:** the test gave `pullEvidence` a fixed 20 ms (`settled`) to reach `bodies.put`. Ingestion first reads the spool and fetches the body asynchronously; under aggregate load that took longer than 20 ms, so `putIds` was still empty. The later `Cannot use a closed database` came from the failed test leaving the gated pull running while harness cleanup closed the database.
- **Fix (test only):** `recordingSync` now exposes `directoryEntered`, released when the first directory sync starts (necessarily after the rename), and the ingestion test's `put` spy releases `putEntered` when called. Each test awaits that event (raced against the operation settling, so an early failure still reports) before the existing `settled` check. The assertions are unchanged. The ingestion test's `finally` now releases the gate and awaits the pull before restoring the spy, so a failed assertion no longer leaves a pull running into harness cleanup (the source of the follow-on `Cannot use a closed database`). The same latent race in `adopting a body whose directory sync is under way waits for it` was fixed the same way: if `first` had not yet renamed, `reuse` found no body and resolved early.
- **Reproduced:** yes. Temporarily adding a 40 ms delay to the recording file sync and to the `put` spy entry (simulating slow thread-pool I/O on a loaded host) failed all three tests: line 112 `existsSync(target)` false, line 260 `adopted` settled, line 341 `putIds.length` 0. With the fix and the same delays: `bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts --rerun-each=3` passed.
- **Verification:** delays removed; `mise run test:logged -- --name evb-stress -- bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts src/core/change-tracking/object-store-write-path.test.ts --rerun-each=20 --parallel=2` PASS (74.0 s, exit 0).
