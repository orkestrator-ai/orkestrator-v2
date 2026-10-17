# Web annotation quota hook timeout under aggregate load

- **ID:** 0204
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing`.
- **Owning file:** `apps/backend/src/core/web-annotation-quotas.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`,
  with the documented macOS GNU-tool PATH.
- **Worker configuration:** workspace packages `--parallel=1`, two package
  tasks; root, bridge and protocol groups also ran on the host.
- **Failure:** a beforeEach/afterEach hook exceeded its 10,000 ms deadline,
  reported at 10,000.19 ms.
- **Backend suite:** 5,875 passed, 15 skipped, 27 failed across 329 files in
  442.53 seconds; 22 failures reproduced as tmux cleanup errors on this host.
- **Isolated rerun:** with the same PATH,
  `mise run test:logged -- --name quotas-rerun -- bun --cwd=apps/backend test ./src/core/web-annotation-quotas.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 5.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass supports a load-sensitive fixture setup or cleanup timeout;
the evidence does not establish which hook stalled. No test assertions, deadlines
or skips were changed.

## Additional observation on 2026-10-13

- **ID:** 0204
- **Status:** open
- **Date observed:** 2026-10-13
- **Original command:** `mise run test:logged -- --name fix-full-suite -- mise run test`
- **Worker configuration:** normal aggregate allocation; backend used one Bun worker while root and bridge groups and component/isolated browser validation ran on the host.
- **Failure:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing` in `apps/backend/src/core/web-annotation-quotas.test.ts` exhausted a beforeEach/afterEach hook timeout at 10005.53 ms.
- **Suite counts:** backend reported 5877 passed, 15 skipped and 25 failed; 22 failures were environment-move cleanup errors and two were keyed-scheduling timeouts.
- **Isolated rerun:** `mise run test:logged -- --name fix-quotas-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/web-annotation-quotas.test.ts --parallel=1 --only-failures` passed (exit 0, 2.4 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.Pv387k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** fixture lifecycle work exceeded its deadline under aggregate load or shared backend activity. The owning test and backend were unchanged; the cause is unconfirmed. No test was skipped or timeout raised.

## Investigation on 2026-10-17 (not reproduced; still open)

- **Host:** macOS, `main` at `31d0fb06`, host load average about 13 on 18 cores
  (nine other worktrees running live suites).
- **Phase timings, alone:** the case's restart (closing the first service and
  initializing a second over 5,000 seeded request rows) took 33 to 39 ms, and
  the `afterEach` cleanup took 3.7 to 4.4 ms (three runs, with timing probes
  that were then removed).
- **Under load:** eight concurrent copies of `web-annotation-quotas.test.ts`
  with `web-annotation-payloads.bench.test.ts`, twice, all passed (2.2 to
  2.7 s each). All 22 `web-annotation*.test.ts` files with `--parallel=2`, four
  times: 265 passed each time (4.2 to 5.2 s).
- **Lead, unconfirmed:** both recorded failures stopped within 6 ms of 10 s
  (10,000.19 and 10,005.53 ms), not at a load-dependent time. 10 s is also the
  SQLite `busy_timeout` that `StorageDatabase` sets (`storage-database.ts`), and
  `bun:sqlite`'s busy handler blocks the event loop while it waits. So a hook
  that hits a held write lock would stall for exactly that long, and Bun could
  report the hook timeout only after it returned. No second writer to the
  harness's private database has been found: the harness closes the first
  service before opening the second, and every transaction is synchronous.
  `WebAnnotationStorage.close()` keeps its store map, and `database()` reopens
  a connection lazily after close. A late write from a closed service would
  therefore open a second connection, but none was observed.
- **Next step:** when it recurs, find which statement blocked, for example by
  lowering the `busy_timeout` in a local `StorageDatabase` build so that the
  `SQLITE_BUSY` error names the statement. No test, deadline or skip was
  changed.
