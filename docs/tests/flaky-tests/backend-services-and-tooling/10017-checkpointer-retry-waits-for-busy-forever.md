# Checkpointer retry test waits forever for a busy checkpoint

- **ID:** 10017
- **Status:** resolved
- **Date observed:** 2026-11-22
- **Test:** `StorageDatabase background checkpoints > the shared worker retries after an independent checkpoint holds the lock`
- **File:** `apps/backend/src/core/storage-checkpointer.test.ts`
- **Branch base:** `307d193174299a7464d948bb4c49a8d975fd0f2b` (`main`)
- **Original command:** CI `mise run test:full`, backend shard (GitHub Actions run 45083334880, `main` push of 307d19317), Bun 1.4.4, four-core `ubuntu-latest` runner.
- **Failure:** The test ran for 60,005.24 ms, the default-tier timeout, and failed. No assertion message; the test was still awaiting `busy.promise`.
- **Isolated rerun:** The aggregate runner's rerun of the owning file alone passed (549 ms, `PASSED ALONE`). A local `bun test --cwd apps/backend ./src/core/storage-checkpointer.test.ts --parallel=1 --rerun-each=20 --only-failures` through `test:logged` on an idle 16-core host did not reproduce it (this test passed all 20 runs).

## Hypothesis

The test waits on `busy.promise` with no deadline of its own. It resolves only
when one of the production worker's PASSIVE checkpoints (every 10 ms in the
test) lands while the competing Worker's `wal_checkpoint(RESTART)` holds the
checkpoint lock, which RESTART holds for at most its 10 s `busy_timeout`
while the test's reader keeps its transaction open. If no PASSIVE result
reports `busy` inside that window (the competing Worker slow to start on a
loaded runner, or ticks starved), RESTART gives up, every later PASSIVE result
is non-busy, and the test hangs until the 60 s timeout. Not yet confirmed; the
next step is a stress run under CPU contention (`mise run test:contention`).

## Resolution (2026-11-25)

Current path: `apps/backend/src/core/storage/checkpointer.test.ts`.

- **Root cause:** SQLite never waits for the checkpoint lock, whatever the
  `busy_timeout`. When the competing worker's one `wal_checkpoint(RESTART)` met
  one of the production worker's PASSIVE passes, it returned busy at once, the
  worker exited, and nothing could make a later PASSIVE pass report busy. The
  hypothesis above (starved ticks inside a 10 s window) was wrong.
- **Fix:** the competing worker asks again until a RESTART completes, which the
  test's reader prevents until it has seen busy. No product code changed.
- **Reproduced:** yes. A RESTART issued while another connection holds the lock
  answered `busy: 1` after 0.1 ms with a 10 s `busy_timeout`. With the production
  worker's interval set to 0 in the test,
  `bun test src/core/storage/checkpointer.test.ts -t "shared worker retries" --isolate --rerun-each=150 --timeout 2500`
  hung 8 of 150 times before and passed 150 of 150 after.
- **Stress:** the whole file, `--parallel=1 --rerun-each=400`, passed 4,000 of 4,000.
