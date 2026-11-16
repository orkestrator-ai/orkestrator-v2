# Cursor steer route escape-heavy ids hook timeout

- **ID:** 0855
- **Status:** resolved
- **Observed:** 2026-10-25, `todo-0066-residual-module-state-40e8f98a7ef0` branch validation
- **Test:** `steer route > escape-heavy ids at the allowed length hit the byte cap before the count cap`
- **File:** `bridges/cursor-bridge/src/steer-journal.test.ts`

## Failure

- **Original command:** `mise run test` (the aggregate `scripts/test-all.ts`),
  workspace/root/bridges/protocol reservations 4/1/2/1; the bridges group ran
  with two worker slots alongside the workspace and root groups.
- **Message:** `^ a beforeEach/afterEach hook timed out for this test.` after
  10004.61 ms.
- **Counts:** cursor-bridge 791 pass, 1 fail, 792 tests across 44 files
  (53.03 s); the bridges group finished FAIL after 166.7 s.
- **Evidence:** `orkestrator-test-run.20ctxb` under the host temporary
  directory (`/var/folders/hc/.../T/`).

## Isolated rerun

```sh
cd bridges/cursor-bridge
bun test src/steer-journal.test.ts
```

21 pass, 0 fail (1.72 s).

## Notes

The branch does not change any bridge code
(`git diff 20f6de911 --stat -- bridges` is empty); it moves backend module
state into `BackendRuntime`. The sibling bounded-steer case 0216 was a hook
timeout from many fsync'd state publications under load; the same contention
is a plausible hypothesis here, not established.

## Resolution (2026-11-15)

- **Root cause:** the case claims up to 256 steers one by one, and every claim and delivery publishes the state file with a file and a directory fsync. The sibling cases 0216 and 0240 stubbed those fsyncs, but this test did not, so on a loaded Linux disk its fsync-bound body ran past the five-second default budget (reported as the hook timeout, 10004.61 ms with teardown). Nothing it asserts depends on how long the flushes take.
- **Fix:** `bridges/cursor-bridge/src/steer-journal.test.ts` now wraps this case in `usePersistenceFsForTests` with no-op `fsyncFile` and `fsyncDirectory`, as the 300-steer case does (writes and renames stay real; `persistence-durability.test.ts` owns flush ordering). The default per-test budget is also 60 s now (`tests/default-test-timeout.ts`), and the file sets no smaller one.
- **Reproduced:** no. The failure was recorded on macOS under aggregate load; I did not make it fail with the unchanged test. The fix removes the cost the sibling cases proved was the cause, so it is reasoned, not measured.
- **Stress:** `mise run test:logged -- --name steer-journal -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/steer-journal.test.ts --parallel=1` passed (2.1 s). Under `mise run test:logged -- --name steer-cont -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/steer-journal.test.ts --rerun-each=5` (base `a8b89f154`; the host was also running many other workers' contention burners on the same pinned core, so the load was far heavier than the runner alone) this case passed in all five runs. The unrelated, already resolved 300-steer case in the same file (0216) timed out at the 60 s default in runs 3 to 5 (60.4 s, 80.8 s, 96.7 s) under that load; it was not changed here.
