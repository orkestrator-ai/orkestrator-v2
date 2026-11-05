# Shell capture descriptor count changes during aggregate validation

- **ID:** 5062
- **Status:** open
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
