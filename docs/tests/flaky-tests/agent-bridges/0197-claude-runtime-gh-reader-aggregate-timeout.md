# Claude runtime GitHub credential probe times out in the aggregate

- **ID:** 0197
- **Status:** open
- **Date observed:** 2026-10-12
- **Test:** `Claude Agent SDK runtime environment > calls the real gh reader with the expected argv and trims its output`
- **File:** `bridges/claude-bridge/src/services/runtime-env.test.ts:162`
- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge-tests-synced -- mise run test`.
- **Worker configuration:** aggregate groups used 2/3/2/1 worker slots; two bridge packages ran concurrently with one Bun worker each.
- **Failure:** expected `fake-token`, received `undefined` after 2007.20 ms.
- **Suite counts:** the bridge group failed; Turbo cancelled remaining bridge work after the failures, so no completed Claude package count was available.
- **Isolated rerun:** `mise run test:logged -- --name merge-claude-runtime-env-alone -- bun test ./bridges/claude-bridge/src/services/runtime-env.test.ts --parallel=1 --only-failures` passed, exit 0, in 3.0 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.C5vOM3/bridges.log.gz`.
- **Hypothesis:** the fixture credential probe returned no token near its two-second deadline under aggregate load. Its owning file passed in isolation; the exact stalled operation remains unknown.

No assertion, timeout or skip was changed.

## Move-fix validation recurrence — 2026-10-12

- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** The same fake-token/undefined assertion recurred at 2023.37 ms.
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-gh-reader-isolated -- bun test ./bridges/claude-bridge/src/services/runtime-env.test.ts --parallel=1 --only-failures` passed, exit 0, in 3.6 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis:** subprocess deadlines under concurrent host load remain plausible; the isolated pass does not establish a root cause. No timeout, assertion or skip was changed.

## Canonical allowlist change — 2026-10-22

- **Original command:** `mise run test:logged -- --name changed -- mise run test:changed`, host load average about 69.
- **Failure:** the case failed at 2018.61 ms; bridge counts 1602 passed, one failed across 1608 tests in 76 files.
- **Owning-file rerun:** `bun test ./src/services/runtime-env.test.ts` in `bridges/claude-bridge` passed (12 tests, 2.24 seconds). The change did not touch the bridge.
- **Evidence:** `/tmp/orkestrator-test-run.pQullD/bridges.log.gz`.
