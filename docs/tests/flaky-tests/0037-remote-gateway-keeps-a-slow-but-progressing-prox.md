# `remote gateway > keeps a slow but progressing proxy body alive past the idle timeout` (`tests/unit/electron/gateway-proxy.test.ts:674`)

- **ID:** 0037
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run concurrently with three typechecks and two other Bun test groups on the same host.
- **Failure:** `expect(received).toBe(expected)`, `Expected: 200`, `Received: 502` (duration: 315.30 ms).
- **Suite counts:** as above — 3,726 passed, 1 skipped, 2 failed.
- **Isolated rerun:** `bun test tests/unit/electron/gateway-proxy.test.ts` → passed in 1.0 s.
- **Follow-up:** A later `--parallel=4` run of the same command passed in 79.2 s without this failure.
- **Hypothesis:** The case drives a deliberately slow proxy body and asserts the idle timer treats forward progress as liveness. Under contention the gaps between the test's own body chunks can exceed the configured idle window, so the gateway legitimately aborts and returns 502. A recurrence should widen the chunk cadence relative to the idle timeout rather than accepting a 502, because tolerating it would stop testing the behaviour.
