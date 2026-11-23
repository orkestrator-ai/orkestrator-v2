# Closing a background-checkpointed database sometimes leaves its WAL

- **ID:** 10019
- **Status:** open
- **Date observed:** 2026-11-23
- **Test:** `StorageDatabase background checkpoints > a backend database checkpoints off the event loop and stops on close`
- **File:** `apps/backend/src/core/storage-checkpointer.test.ts:191`
- **Branch base:** `307d193174299a7464d948bb4c49a8d975fd0f2b` (`main`)
- **Original command:** `mise run test:logged -- --name checkpointer-stress -- bun test --cwd apps/backend ./src/core/storage-checkpointer.test.ts --parallel=1 --rerun-each=20 --only-failures` on an idle 16-core Linux host, Bun 1.4.4.
- **Failure:** `expect(Bun.file(`${db.path}-wal`).size).toBe(0)` received 1,940,552 after `db.close()` and `await workers[0]!.exited` (test duration 14.67 ms). One failure in 200 tests (20 repetitions of the file); 199 passed in 2.87 s.
- **Isolated rerun:** This was already an isolated run of the owning file; the other 19 repetitions of the test passed.

## Hypothesis

The WAL is removed only by the last connection to close. The test assumes
the worker's connection is closed by the time its `exited` promise settles;
a worker that exits on termination rather than after closing its connection,
or a close that races the worker's in-flight PASSIVE checkpoint, would leave
the WAL in place. Possibly a product gap (a closed backend leaving a WAL
behind), not only a test-ordering problem. Not yet investigated.
