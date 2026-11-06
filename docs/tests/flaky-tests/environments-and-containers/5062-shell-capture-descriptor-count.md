# Shell capture descriptor count changes during aggregate validation

- **ID:** 5062
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test/file:** `runCommand capture > keeps no capture file on disk and no descriptor open`, `apps/backend/src/core/shell.test.ts:483`.
- **Original command:** `mise run test:logged -- --name full-after-ignored-write-fix -- mise run test:full`, macOS, backend parallel workers selected by the aggregate scheduler (4 workspace slots reserved). Repair commit `37f6e9a0c`; shell source and owning test are unchanged by this branch.
- **Failure:** expected `/dev/fd` count 113, received 12, after 1,051.60 ms. This is a decrease, not evidence of a descriptor leak.
- **Isolated rerun:** `mise run test:logged -- --name shell-capture-isolated -- bun test --cwd apps/backend ./src/core/shell.test.ts --parallel=1 --only-failures`: exit 0, 12.6 s. Passing output was removed by the logged runner; individual counts were not retained.
- **Hypothesis:** descriptors held before the measurement may have closed during the test in the aggregate process. The exact owners are unproved. No assertion was loosened or skipped.
- **Evidence:** full-suite rerun artifacts and final group counts are recorded below when the aggregate finishes; original preparation artifacts remain unchanged.

## Aggregate result

The command exited 1 after 1,743.1 s (including 372.5 s queued). Backend:
18,218 pass, 214 skip, 9 fail across 1,179 files; web: 12,431 pass,
10 skip, 1 fail; root/support: 3,929 pass, 1 fail. Bridges and protocol-lockfile
groups passed. No failure was reported in the repaired watcher service file.
Compressed evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.RHai3O/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
wrapper: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.T9wTr1/full-after-ignored-write-fix.log.gz`.

### Resolution — 2026-11-06

- **Root cause:** the check counted descriptors for the whole process, so it
  also counted other test files' descriptors. Run with `--isolate`, an
  earlier backend file in the same worker leaves descriptors open:
  `commands-state-sync.test.ts` left about 100 descriptors to deleted SQLite
  stores (`orkestrator.sqlite`, `-wal`, `-shm`) and about 500 directory
  handles, measured on Linux. On Linux they stay open, so the count is
  merely high and stable. On macOS they close at some later point, after
  `Bun.gc(true)` (the 6190 fix) has already taken the baseline, so the
  count fell during the test (113 → 12). That decrease cannot be a leak. The
  closing mechanism on macOS is unproven, but any descriptor that closes
  mid-test breaks an exact count.
- **Fix:** `apps/backend/src/core/shell.test.ts` compares open descriptors by
  the file each refers to (`fstat` device and inode) and fails on any
  descriptor whose file was not open at the baseline. A descriptor the test
  leaves open is still caught when it reuses a number freed by an unrelated
  close, which the count check missed whenever the two cancelled out.
  `readdirSync(directory)` stays empty-checked.
- **Reproduction:** a copy of the test that opens 100 descriptors before the
  baseline and closes them 50 ms in failed the old check with `Expected:
  146, Received: 46`, the recorded shape. With the new check the same copy
  passes. A copy that also leaves one unlinked file in the capture directory
  open fails, as a leak should.
- **Verification:** `mise run test:logged -- --name env-shell-alone -- bun
  --cwd=apps/backend test ./src/core/shell.test.ts --parallel=1
  --rerun-each=5`: PASS. The 6190 neighbour set (`standalone-logging`,
  `shell`, `coordinator-node-coordinator-mail`, `public-api-schedules`,
  `commands-state-sync`) with `--parallel=2 --rerun-each=3`: PASS.
- **Separate finding, not fixed here:** `commands-state-sync.test.ts` leaves
  about 34 SQLite stores open after its files are deleted. The owner of that
  file should close them.
