# Disk report checkout fixture times out in the aggregate

- **ID:** 0259
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts`
- **Owning file:** `tests/unit/disk-report.test.ts`
- **Original command and workers:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities available in PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers and root used one. Component and isolated-stack browser validation ran alongside it.
- **Failure:** The 5000 ms deadline expired at 5036.36 ms; `report.status` was null rather than 0, also producing an error between tests.
- **Suite counts:** Root/support: 2,997 passed, one skipped, three failed and one error across 3,001 tests (402.27 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-disk-report-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 1.7 s, with the same PATH preference.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** process and filesystem contention on the shared host is plausible but unconfirmed. No assertion, timeout or skip was changed.
