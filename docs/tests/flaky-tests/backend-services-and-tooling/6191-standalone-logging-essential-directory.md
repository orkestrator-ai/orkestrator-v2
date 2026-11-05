# Standalone logging shutdown test reads the essential directory as a file

- **ID:** 6191
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `standalone backend logging > shutdown leaves every queued line in the file`
- **File:** `apps/backend/src/standalone-logging.test.ts`
- **Original command:** CI `mise run test:full`, the backend shard. It failed in 6 of the 10
  failed `main` runs checked on 2026-11-04, for example `e198fd4a7` (run 41887107581):
  `EISDIR: illegal operation on a directory, read`, 22.86 ms.
- **Isolated rerun:** `mise run test:logged -- --name ci-inv-logging-alone -- bun --cwd=apps/backend test src/standalone-logging.test.ts --parallel=1 --only-failures`
  passed on macOS. Not rerun alone on Linux.

## Cause

Inferred from the error and the code; the directory listing on CI was not observed. The test
read `files[0]` from an unfiltered `readdir` of `logs/`, which since #1731 also holds the
`essential` directory, and `readdir` order is not guaranteed.

## Fix

On `investigate-ci-f07d88911341-r1`, the test filters out `essential` as its neighbours in the file do, and
asserts that one log file remains.
