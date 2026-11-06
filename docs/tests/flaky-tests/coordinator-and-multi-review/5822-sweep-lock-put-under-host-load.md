# A put during a long sweep times out under parallel load

- **ID:** 5822
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `a sweep's lock > a capture's write finishes while a long sweep is still walking`
- **File:** `apps/backend/src/core/change-tracking/retention-store-walks.test.ts`
- **Original command:** `mise run test:logged -- --name change-tracking -- bun --cwd=apps/backend test src/core/change-tracking --parallel=4 --only-failures`, during the E3 retention work (efficiency report 0540) on branch `retention-deletion-f42f0bad1e3b-r1` based on `54911a112`.
- **Worker configuration:** four isolated Bun workers over the 25 change-tracking test files on an external volume; host load average about 50 (other worktrees' suites running).
- **Failure:** the test exceeded Bun's 5000 ms deadline (5066.28 ms reported).
- **Suite counts:** 321 pass, 2 fail, 1 error across 323 tests in 24 files (47.95 s). The other failure and the error are flake [5360](5360-measurement-file-cap-restore-plan-parallel-timeout.md).
- **Isolated rerun:** `mise run test:logged -- --name walks -- bun --cwd=apps/backend test src/core/change-tracking/retention-store-walks.test.ts --parallel=1 --only-failures` passed the complete owning file (8.7 s).
- **Hypothesis:** the fixture writes 1,500 old objects with their mtimes set one by one before the sweep starts, which takes most of the deadline on a loaded host and a slow volume. The change under test did not touch `ObjectStore`, so this is the fixture's setup cost rather than the lock it asserts on. Not reproduced under stress.

## Flow viewport review validation recurrence — 2026-11-06

Observed on `d81fd21ed` in
`mise run test:logged -- --name review-default-tests -- mise run test`.
This branch changes the shared flow viewport and its renderer tests, plus
qualification documentation; it changes none of this owner's implementation.
The aggregate finished in 1615.7 s. Backend used four isolated workers
(16,358 pass, 134 skip, three failures); root used one worker
(3,674 pass, three failures). Web passed with 13,101 pass and ten skips.
Original evidence is under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fvkr6h/`;
the outer wrapper is `orkestrator-test-run.OXNmsh` under the same temporary root.

The exact capture-write test timed out at 6528.51 ms against the 5000 ms
deadline in `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Unchanged complete owner rerun:

```sh
mise run test:logged -- --name retention-walks-isolated -- bun --cwd=apps/backend test src/core/change-tracking/retention-store-walks.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 2.1 s. Passing output was deleted by the logged
runner, so isolated totals are not inferred. The isolated pass establishes
intermittence, not a cause or a repair. No assertion, timeout or skip changed.

### Resolution — 2026-11-06

- **Root cause:** the test relied on volume to make the sweep "long". It created
  and individually aged 1,500 old blobs so that the walk would outlast one put.
  That setup was most of the cost, so on a loaded host and a slow volume the test
  crossed Bun's 5 s deadline. The lock behaviour it asserts on was never at fault
  (the hypothesis above was right).
- **Fix (test only):** `apps/backend/src/core/change-tracking/retention-store-walks.test.ts`.
  The test wraps the store's `exclusive` seam, as the neighbouring
  `beforeFirstHold` helper does. After the sweep's first removal hold has
  released the lock, the sweep is held mid-walk until the put has finished. The
  put must still finish first (`["put", "sweep"]`). The test now also asserts
  that the sweep really was mid-walk: more than half of the old blobs still exist
  when the put completes, and all are removed at the end. If a sweep held the
  lock across its walk, the put could not finish first: a 10 s bound releases the
  gate, and the order assertion fails instead of the test hanging. The setup is
  128 blobs (checked to span more than one fan-out prefix) instead of 1,500.
- **Reproduced:** not as a failure. Pinned to one core beside 8 busy loops, the
  unchanged test averaged about 1.6 s per run (5 runs, 8.2 s) and the new one
  about 0.15 s (20 runs, 3.3 s).
- **Verification:** `mise run test:logged -- --name coord-5822-fix -- bun --cwd=apps/backend test ./src/core/change-tracking/retention-store-walks.test.ts -t "a capture's write finishes" --rerun-each=50`:
  50/50 pass. `coord-5822-fix-load` (`--rerun-each=20`, one-core contention):
  20/20 pass. `coord-ct-files` (this owner and `measurement-file-cap.test.ts` in
  full): pass.
