# Object store byte-bound flush times out on a loaded host

- **ID:** 6062
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `a batch > flushes at the compressed byte bound below the object-count bound`
- **File:** `apps/backend/src/core/change-tracking/object-store-write-path.test.ts:236`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, review preparation of `76136cdb7` on branch `move-pipe-captures-c7893f496669-r1`, based on `af2e566e5`.
- **Worker configuration:** concurrent aggregate workspace run; the granted worker count was not recorded in the review package.
- **Failure:** exceeded Bun's 5000 ms deadline (5012.20 ms reported). In the isolated reruns below, cleanup then removed the store under the timed-out test, giving an unhandled `ENOENT` from `object-store.ts:333` between tests. The aggregate log was unavailable at finalization, so the same error there is inferred from this run's one reported backend error, not read.
- **Suite counts:** backend 15,564 passed, 2 failed, 1 error, 132 skipped across 1044 files (497 s).
- **Isolated rerun at the default deadline:** `mise run test:logged -- --name own-object-store -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/change-tracking/object-store-write-path.test.ts --parallel=1 --only-failures'` failed three times out of three at a host load average of 33 to 37 on 12 cores (5016 to 5057 ms; 23 pass, 1 fail, 1 error). No idle-host run was possible, so this does not yet meet the register's "passes alone" bar.
- **Diagnostic rerun:** the same command with `--timeout=60000` passed the test filtered to its name in 8.4 s total at a load average of 37, and passed the whole file together with `measurement-file-cap.test.ts` in 34.0 s. The flag was used only on the command line to tell a stall from slowness; no deadline was changed.
- **Scope:** the test stages 64 MiB of random data and fsyncs it. It runs no child process, so it does not reach the capture code the branch moved, and the branch changes nothing under `change-tracking/`.
- **Hypothesis:** slow rather than stalled: compression and fsync of 64 MiB take close to the default deadline on this host under load. Unconfirmed: the test's duration on an idle host. No assertion, timeout or skip was changed.
