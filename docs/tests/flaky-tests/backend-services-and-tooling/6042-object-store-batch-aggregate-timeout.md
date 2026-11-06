# Object-store compressed-byte batch aggregate timeout

- **ID:** 6042
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `a batch > flushes at the compressed byte bound below the object-count bound`
- **File:** `apps/backend/src/core/change-tracking/object-store-write-path.test.ts`
- **Original command:** `mise run test` during Static Find review repairs, after commit `c4448a5ad`; aggregate workspace used four backend workers (runner reported `4x PARALLEL`).
- **Failure:** timeout at 5020.20 ms, limit 5000 ms; an outstanding stage subsequently rejected with ENOENT in `object-store.ts:333`, called from the test at line 246, after its temporary root had gone.
- **Suite counts:** backend 15519 pass, 132 skip, 1 fail, 1 error; web separately 12590 pass, 10 skip, 1 fail.
- **Evidence:** `/tmp/orkestrator-test-run.PpclE3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer runner `/tmp/orkestrator-test-run.QEP3Fx/repaired-aggregate.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name object-write-alone -- bun --cwd=apps/backend test ./src/core/change-tracking/object-store-write-path.test.ts --parallel=1 --only-failures` passed, exit 0, 3.3 s.

Preparation had also reported this timeout. No implementation or assertion changed. The post-timeout ENOENT is consistent with cleanup racing outstanding work; the cause of the initial timeout is unestablished. Keep the assertions and investigate recurrence.

## Recurrence 2026-11-06 — coordinator Work panel removal

`mise run test:logged -- --name address-default-suite -- mise run test`
failed on this unchanged backend test at 5013.31 ms (5,000 ms deadline)
with four backend workers. Backend totals: 16,356 pass, 126 skip, three failures and two errors;
web: 12,990 pass, zero failures. The same run also caught two new test type
errors, corrected in `5f5cb11b1`. Evidence:
`/tmp/orkestrator-test-run.srVdfm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The owning file passed unchanged with
`mise run test:logged -- --name address-object-store-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/object-store-write-path.test.ts --parallel=1 --only-failures`
(exit 0, 6.6 s). No assertion, skip, or timeout was changed. The coordinator
renderer removal does not edit this backend path; initial timeout cause remains
unconfirmed. A fresh aggregate run follows the test type fix.

### Resolution — 2026-11-06

- **Root cause:** the test reached the production byte bound (`BATCH_MAX_BYTES`, 64 MiB) with four 16 MiB `randomBytes` inputs, so it generated, hashed, deflated (off-loop, four zlib slots) and wrote 64 MiB of incompressible data. That is seconds of CPU and I/O on an idle host and more than 5 s on a loaded one. The late ENOENT was the still-running `put` writing into the temporary root that `afterEach` had already removed after the timeout.
- **Reproduced:** yes, in isolation while other agents loaded the host (load average about 21): `bun test src/core/change-tracking/object-store-write-path.test.ts` failed this test at 5019.73 ms and again at 5020.25 ms.
- **Fix:** `ObjectStoreOptions.batchMaxBytes` (product code, `apps/backend/src/core/change-tracking/object-store.ts`) sets the bound a batch flushes at; it defaults to `BATCH_MAX_BYTES`, so production is unchanged. The test sets 1 MiB and uses four 256 KiB inputs. Each input is still above `OFF_LOOP_ZLIB_BYTES`, so the off-loop compression path is still covered, and the test asserts both relationships. Every original assertion is kept: nothing syncs at three objects, four objects flush, the temporaries are gone, and the tail waits for close.
- **Verification (load average about 29):** `mise run test:logged -- --name objstore-one -- bun test --cwd apps/backend src/core/change-tracking/object-store-write-path.test.ts src/core/change-tracking/object-store.test.ts` PASS (6.6 s); `mise run test:logged -- --name objstore-stress -- bun test --cwd apps/backend src/core/change-tracking/object-store-write-path.test.ts --rerun-each=20 --parallel=2` PASS (102.8 s, exit 0).
