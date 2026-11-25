# Closing a background-checkpointed database sometimes leaves its WAL

- **ID:** 10019
- **Status:** resolved
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

## Resolution (2026-11-25)

Current path: `apps/backend/src/core/storage/checkpointer.test.ts`.

- **Root cause:** SQLite empties the WAL only on the last close, which it
  recognises by taking an exclusive lock. `close()` posts the worker its close
  and then closes the backend connection, so the two closes run on two threads;
  when they overlap, each sees the other's shared lock and neither empties the
  WAL. The next sole connection empties it. A backend shutdown is not affected:
  it waits for its workers before it closes its connections.
- **Fix:** both tests that read the WAL's size after such a close now open and
  close a fresh connection first (`expectNoOpenConnection`). A connection the
  worker had leaked would still fail them. No product code changed.
- **Reproduced:** yes. The unchanged file at `--rerun-each=150` failed 2, 1 and
  2 of 150 on an idle 16-core host. A script with no repository code (two
  connections closed at once on two threads) left the WAL once in 2,400 tries,
  and the next sole connection emptied it.
- **Stress:** `bun test ./src/core/storage/checkpointer.test.ts --parallel=1 --rerun-each=400 --only-failures`
  passed 4,000 of 4,000.
