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

## Recurrence during merge conflict validation (2026-10-13)

- **Original command:** the GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name merge-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots;
  root files used three isolated Bun workers. Browser validation also ran.
- **Root-suite counts:** 5,073 total, 5,044 passed, 24 skipped, 5 failed and
  1 additional error across 256 files in 238.08 seconds. Workspace, bridges,
  protocol and browser groups passed.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6mi44l/root-and-agent-support-tests.log.gz`
  and the adjacent `summary.json`.
- **Tests:** `deletes the remote head branch during merged running container cleanup`
  (6,616.41 ms), `does not delete remote branches when a merged container environment is not running`
  (6,340.66 ms), and `retains the environment and process ownership when deletion cannot reap a server`
  (5,531.92 ms), each exceeding its five-second deadline. The first timeout
  also produced a late missing-fixture `docker-rm.log` error after cleanup.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name merge-environments-isolated -- bun test ./tests/unit/electron/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 31.1 seconds.
- **Hypothesis:** the aggregate deadline failures match earlier observations;
  unchanged owning files pass alone. Contention may contribute, but the root
  cause remains unconfirmed. No assertion, timeout or skip was changed.
