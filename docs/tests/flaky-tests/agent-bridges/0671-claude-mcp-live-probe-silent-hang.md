# Claude MCP live probe produced no output under `verify:claude:mcp-live`

- **ID:** 0671
- **Status:** open
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
