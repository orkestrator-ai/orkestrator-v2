# Codex handshake failure harness exits without a result

- **ID:** 0233
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `app-server engine over HTTP > reports a bounded, actionable error when the handshake never completes`
- **File:** `bridges/codex-bridge/src/app-server-http.test.ts:161`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-latest-full-suite -- mise run test`.
- **Worker configuration:** workspace four slots, root one, bridges two (one Bun worker per bridge task), protocol check one. The component browser suite also ran on the host.
- **Failure:** `harness produced no output (exit 0)` with stderr `Failed to start the app-server engine: app-server is stopped`; test duration 1,151.07 ms.
- **Suite counts:** Codex did not finish its package suite. The bridge group stopped after ACP reported 499 passed, three skipped and one failed.
- **Isolated rerun:** `mise run test:logged -- --name merge-codex-http-isolated -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-http.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, wrapper duration 6.0 seconds.
- **Evidence:** `bridges.log.gz` in `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/`.
- **Hypothesis:** this may be a consequence of Turbo interrupting Codex after the sibling ACP failure, rather than an independent handshake regression. The empty-result failure appeared during that shutdown; the isolated rerun passed. No harness timeout or assertion was changed.

## Triage (2026-11-15): left open

Class D. The recorded output (`exit 0`, no JSON on stdout, stderr `app-server is stopped`) is what the harness child looks like when it is stopped from outside, which fits the case's own hypothesis that Turbo interrupted the package after the sibling ACP failure. The harness (`testing/http-flag-harness.ts`) always prints a JSON line before exiting 1, so a clean empty exit is not a path the test itself produces. I could not establish this and made no change; the file passed with its neighbours (`app-server-http.test.ts`, 2.4 s). Its explicit budgets are already 60 s and the 500 ms readiness figure is the product timeout under test (`CODEX_BRIDGE_HTTP_HARNESS_READY_TIMEOUT_MS`), not a wait on this host's speed.

## Note (2026-11-15): left open

The no-output watchdog that stopped sibling packages (0262, 0164) now follows
per-test progress (`scripts/test-progress-dots.ts`), which removes one way a
healthy bridge group was interrupted. This case's own trigger was Turbo
stopping Codex after a real ACP failure, so it stays open until a recurrence
shows whether the handshake test fails independently.

## Resolution (2026-11-19) — the harness was stopped from outside

- **Reproduced on demand:** spawning `src/testing/http-flag-harness.ts` with the
  test's environment (`FAKE_CODEX_SCRIPT=no-initialize`,
  `CODEX_BRIDGE_HTTP_HARNESS_READY_TIMEOUT_MS=500`) and sending it `SIGTERM`
  150 or 300 ms after start gave exactly the recorded result: exit 0, no JSON line
  on stdout, stderr `engine.start-failed ... "app-server is stopped"`. The
  bridge's `SIGTERM`/`SIGINT` handler (`createShutdownHandler` in `src/index.ts`)
  stops the engine, which fails the pending start, and exits 0 before the
  harness's `main()` can print a result. The handshake test cannot produce that
  output on its own: every path in `main()` prints a JSON line. This confirms the
  case's hypothesis that Turbo stopped the package after the sibling ACP failure.
- **A second trigger, found and fixed:** the parent-exit watchdog runs the same
  drain. The harness inherited the test process's whole environment, including
  `ORKESTRATOR_PARENT_PID`, which an agent shell carries with the production
  backend's PID; the harness then watched a process that was not its parent.
  With `ORKESTRATOR_PARENT_PID=99999999` (no such process) the unchanged file
  failed (`mise run test:logged -- --name forkb-0233-repro -- bun test --cwd
  bridges/codex-bridge --preload ../../tests/setup-node.ts
  ./src/app-server-http.test.ts --parallel=1`: 2 pass, 1 fail). The failure there
  was a JSON parse error, because `ORKESTRATOR_BRIDGE_DEBUG` (also inherited from
  the agent shell) put a `[bridge-diagnostics]` line last on stdout.
- **Fix:** `src/app-server-http.test.ts` passes `ORKESTRATOR_PARENT_PID` set to
  its own PID (the process that actually spawned the harness), reads the result
  from the last stdout line that starts with `{`, and explains what an empty
  exit 0 means. `src/testing/http-flag-harness.ts` writes
  `[http-flag-harness] received SIGTERM; exiting without a result` to stderr on
  `SIGTERM`/`SIGINT`, so an interrupted run now names the signal in the failure.
- **Verification:** the same dead-parent command with the fix and
  `--rerun-each=3` passed (`forkb-0233-fixed`, 9.8 s); the `SIGTERM` probe now
  prints the signal line before the bridge's own `engine.start-failed` line.
