# Cursor runtime-health read times out only in the aggregate

- **ID:** 0185
- **Status:** open
- **Date observed:** 2026-10-08
- **Test:** `liveness routes > runtime health reports the attached agent's MCP configuration without attaching`
- **File:** `bridges/cursor-bridge/src/http.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite-final -- mise run test` with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** Aggregate groups used 2/3/2/1 slots; bridge packages each had one Bun worker, two packages concurrently.
- **Failure:** Bun's 5000 ms test timeout expired; reported duration 8527.55 ms.
- **Suite counts:** Cursor package: 667 passed, 1 failed (668 total).
- **Isolated rerun:** The owning file passed alone in 1.4 seconds, exit 0:

```bash
mise run test:logged -- --name cursor-http-rerun -- \
  bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts \
  ./src/http.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.qWLwsI/bridges.log.gz`.

The entire owning file completed below the failing test's deadline in isolation,
which suggests a load-sensitive wait. Available evidence does not identify which
wait or transport operation stalled. No assertion, timeout or skip was changed.

## Recurrence during worktree-storage merge validation (2026-10-12)

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge-tests-synced -- mise run test`.
- **Worker configuration:** aggregate groups used 2/3/2/1 worker slots; two bridge packages ran concurrently with one Bun worker each.
- **Failure:** the same runtime-health case exceeded its five-second deadline (5620.96 ms), followed by an unhandled error between tests.
- **Suite counts:** Cursor: 667 passed, 1 failed, 1 error; 668 tests across 38 files.
- **Isolated rerun:** `mise run test:logged -- --name merge-cursor-http-alone -- bun test ./bridges/cursor-bridge/src/http.test.ts --parallel=1 --only-failures` passed, exit 0, in 4.8 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.C5vOM3/bridges.log.gz`.

The isolated pass confirms recurrence; the stalled operation remains unknown. No assertion, timeout or skip was changed.

## Recurrence during change-tracking adapter validation (2026-10-20)

- **Original command:** focused Cursor bridge runs that included `src/http.test.ts` alongside the new `src/change-evidence.test.ts` and `src/command-changes.test.ts` (multi-file `bun test … --parallel=2`).
- **Failure:** the same runtime-health case hit its hook timeout in both multi-file runs.
- **Isolated reruns:** `src/http.test.ts` alone failed once in five runs and passed the other four. The case does not use dispatch or the new `/change-evidence` routes.
- **Suite counts:** Cursor package: 774 passed, 1 failed.

Failing once alone on a loaded host keeps this load-sensitive; the stalled operation is still unidentified. No assertion, timeout or skip was changed.
