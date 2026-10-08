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
