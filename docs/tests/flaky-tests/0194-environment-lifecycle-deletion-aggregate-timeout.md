# Environment lifecycle deletion cases time out in the aggregate

- **ID:** 0194
- **Status:** open
- **Date observed:** 2026-10-12
- **Tests:** in `Electron backend environment lifecycle commands`:
  `deletes the remote head branch during merged running container cleanup`
  (8,786 ms), `does not delete remote branches when a merged container
  environment is not running` (7,738 ms), `does not delete remote branches when
  a merged environment has no PR url` (5,572 ms), `removes the environment even
  when remote branch deletion fails for a non-404 reason` (6,912 ms), and
  `retains the environment and process ownership when deletion cannot reap a
  server` (6,242 ms).
- **File:** `tests/unit/electron/commands-registry-environments.test.ts`
- **Original command:** `mise run test:logged -- --name full-tests-2 -- mise run test`
  on macOS; root group 4992 passed, 24 skipped, 19 failed, 3 errors across 253
  files in 390 seconds.
- **Failure:** each exceeded the five-second test timeout.
- **Isolated rerun:** `bun test ./tests/unit/electron/commands-registry-environments.test.ts`
  passed 68 of 68. The first full run of the same tree earlier that day also
  passed these cases.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.j4rNKa`.

The cases drive fake `git`, `docker` and `gh` shims under the default
five-second budget, like the resolved fixture-shim timeouts in case 0130.
Host contention is the likely cause; the isolated pass does not prove it. No
test was skipped, loosened, or changed to conceal the failure.

## Recurrence 2026-10-13

- **Tests:** `does not delete remote branches when a merged container
  environment is not running` (5,868 ms) and `retains the environment and
  process ownership when deletion cannot reap a server` (6,897 ms).
- **Original command:** `mise run test:logged -- --name electron-unit -- bun test
  tests/unit/electron --parallel=4 --only-failures` on macOS during the Electron
  44 upgrade (no change to the backend or this file); 1939 passed, 23 skipped,
  2 failed across 115 files in 261.6 seconds, with a host load average near 30
  from other concurrent agent runs.
- **Isolated rerun:** `bun test tests/unit/electron/commands-registry-environments.test.ts`
  passed in 81.1 seconds under the same host load.
