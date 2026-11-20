# runCommand descriptor check counts another file's uncollected descriptors

- **ID:** 6190
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `runCommand capture > keeps no capture file on disk and no descriptor open`
- **File:** `apps/backend/src/core/shell.test.ts`
- **Original command:** CI `mise run test:full`, the backend shard. It failed in 7 of the 10
  failed `main` runs checked on 2026-11-04, for example `e198fd4a7` (run 41887107581):
  `Expected: 21`, `Received: 12`, 991.41 ms.
- **Isolated rerun:** `bun --cwd=apps/backend test src/core/shell.test.ts --parallel=1 --only-failures`
  passed 6 of 6 on macOS.
- **Reproduction:** on macOS, running it with four neighbours failed 5 of 5 (`Expected: 18`,
  `Received: 10`):
  `bun test src/standalone-logging.test.ts src/core/shell.test.ts src/core/coordinator-node-coordinator-mail.test.ts src/core/public-api/public-api-schedules.test.ts src/core/commands-state-sync.test.ts --parallel=2`
  from `apps/backend`. The same set without `commands-state-sync.test.ts` passed 6 of 6.

## Root cause

The count fell, so nothing leaked. An instrumented copy read 18 descriptors, then 10 after
`Bun.gc(true)`, and 10 at the end of the test. The baseline included descriptors that an
earlier file in the same worker had left waiting for collection.

## Fix

On `investigate-ci-f07d88911341-r1`, the test forces a collection before each read and keeps the exact
comparison, so it is no looser. The reproduction above then passed 5 of 5 (262 pass, 0 fail).
