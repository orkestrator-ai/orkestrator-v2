# Claude MCP live probe produced no output under `verify:claude:mcp-live`

- **ID:** 9873
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `a running Claude CLI unloads removed and renamed MCP servers`
- **File:** `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live.test.ts`
- **Original command:** `mise run test:logged -- --name claude-mcp-live -- mise run verify:claude:mcp-live`
- **Worker configuration:** the task's own `bun test --parallel=1` on that one file, macOS on Apple Silicon, Bun 1.4.3, Claude CLI 2.1.296. At the same time a `dev:test` profile (`qa-mcp-pi-1022`, Pi only) was running and a Pi live MCP Playwright run was driving it.
- **Failure:** after the `bun test v1.4.3 (c6da4a4d3) 1x PARALLEL` banner nothing was printed for 300 s; the logged runner's no-progress watchdog terminated the process tree (`timeoutReason: "no-progress"`), 964.1 s elapsed in total. The test's own 90 s probe deadline did not end it either, so no test result or probe output was recorded.
- **Suite counts:** none reported (killed before any result).
- **Isolated rerun:** running the probe directly, `bun src/services/session-manager-prompt-mcp-sync.live-probe.ts` from `bridges/claude-bridge`, exited 0 with the expected result line; the same `mise run test:logged -- --name claude-mcp-live -- mise run verify:claude:mcp-live` then passed in 6.0 s.
- **Hypothesis:** none evidence-backed. The probe's 90 s `probe.kill()` should have ended a hung probe, so the stall may be in the `bun test` parallel worker itself rather than in the CLI; the concurrent live profile is the only unusual load. Capture `ps` of the process tree if it recurs.
- **Second observation (2026-10-22):** in `ORKESTRATOR_TEST_WORKERS=4 mise run test:logged -- --name claude-bridge-tests -- bun run --cwd bridges/claude-bridge test:bridge` (four workers instead of the default one, alongside the same live profile), the test failed after 42.4 s with the probe's own `Error: MCP servers did not finish connecting` (`session-manager-prompt-mcp-sync.live-probe.ts:129`). The same suite at its default single worker passed this file. Both observations were under heavy host load.

## Resolution (2026-11-15)

- **Root cause:** the live probes behind this test bounded their waits by
  wall clock, and some ended on a fixed sleep rather than a state:
  - `READY_TIMEOUT_MS` was 20 s in `session-manager-prompt-mcp-sync.live-probe.ts`
    and `claude-mcp-replace-linger.live-probe.ts`.
  - Two 20 s deadlines in `session-manager-prompt-mcp-sync.live-calls.ts`.
  - Sleeps of 1 s, 2 s and 3 s before reading which server processes were
    alive.
  - The test's own 90 s `probe.kill()` deadline.

  On a starved host the CLI and its MCP servers start slowly enough to miss
  them. That matches the second observation, `MCP servers did not finish
  connecting`. The first observation, 300 s with no output, was not
  explained.
- **Fix:**
  - Every probe wait is a 120 s hang watchdog on a real state.
  - The fixed sleeps are replaced by waits for the state they stood in for:
    - no server still `pending`, and every live server process belonging
      to a loaded server;
    - the replaced server's exit in the `dynamic` scenario;
    - all server processes gone after the CLI exits.
  - When a settle watchdog expires, the probe returns its observation, so
    the test's `toEqual` shows what differs.
  - The test's probe watchdog is 240 s, with a test budget of 270 s.
  - The expectations are unchanged.
- **Reproduced:** partly. With the probe changes but the original 20 s
  deadlines still in `live-calls.ts`, a run under
  `bun scripts/test-under-contention.ts --burners 6` (core 15, host load
  about 82) failed after 49.1 s with `File-only fixture was not connected`.
  That is that file's 20 s deadline, the same class as the second
  observation. After that deadline became the watchdog, the same command
  passed three fresh processes in a row (2 of 2 each, 68 to 75 s). The
  silent 300 s hang from the first observation was not reproduced.
- **Stress:** the three contention runs above, plus one pass on core 7
  (13.3 s). The suites ran with `CLAUDE_CLI_PATH` unset, so they used the
  SDK's bundled CLI. That is what the guard requires when the inherited
  path points into the real data directory.
