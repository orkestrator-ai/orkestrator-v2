# Claude runtime GitHub credential probe times out in the aggregate

- **ID:** 0197
- **Status:** resolved
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

## MCP overlay review validation — 2026-10-23

The unchanged fake-token reader returned `undefined` at 2021.13 ms in `mise run test:logged -- --name repository-tests -- mise run test`. The complete owner passed with `mise run test:logged -- --name claude-runtime-owner -- bun test --cwd bridges/claude-bridge ./src/services/runtime-env.test.ts --parallel=1 --only-failures` (exit 0, 2.2 s). No assertion, timeout or skip changed. Evidence: host temporary directory `orkestrator-test-run.ZHucAO/bridges.log.gz` and outer `orkestrator-test-run.MYw34M/repository-tests.log.gz`. The aggregate remains failed; subprocess contention remains a hypothesis.

## Resolution (2026-11-15)

- **Root cause:** `readGitHubCliToken` runs a real `gh` and kills it after a fixed
  two-second `execFile` timeout (`GH_TOKEN_TIMEOUT_MS`). The test spawned a fixture
  `gh` shell script through that same product deadline, so a host too busy to start
  and finish the script in two seconds got `undefined` back (the product correctly
  gave up). The companion case `bounds a stalled gh lookup` asserted
  `Date.now() - started < 3_500`, a wall-clock bound, and carried a 5 s test budget.
- **Fix:** `bridges/claude-bridge/src/services/runtime-env.ts`: `readGitHubCliToken`
  takes an optional `timeoutMs` that defaults to the unchanged two-second product
  constant. `runtime-env.test.ts`: the three fixture-`gh` assertions that wait for a
  result pass a 30 s hang watchdog. The stalled-lookup case now runs a `gh` that
  records its pid and `exec`s `sleep 600` (past the test's 60 s budget, so a broken deadline fails the test as a hang) with a 250 ms injected deadline, then checks
  the lookup was `undefined` and, when `gh` had started, that its process is gone:
  the deadline ended it, not the clock. The elapsed-time assertion and the 5 s budget
  are removed.
- **Reproduced:** no. The recorded failure needs a starved host; the unchanged test
  was not rerun under contention before the fix, so this is a reasoned fix.
- **Stress:** `mise run test:logged -- --name repro-gh -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/claude-bridge ./src/services/runtime-env.test.ts --preload ../../tests/setup-node.ts --rerun-each=5`
  passed (host load average above 100 from other workers at the time). A passing
  stress run is weaker evidence than a reproduction.
  After the `sleep 600` change, the same command with `--core 7` passed 5 of 5.
