# Codex `item-to-parts` file fails when the shell exports `PORT`

- **ID:** 0660
- **Status:** environmental
- **Date observed:** 2026-10-21
- **Test:** every case in the file (none run)
- **File:** `bridges/codex-bridge/src/item-to-parts.test.ts`
- **Original command:** `mise run test:logged -- --name codex-bridge -- bun --cwd=bridges/codex-bridge test --parallel=4 --only-failures`
- **Failure:** `# Unhandled error between tests` with `error: Failed to start server. Is port 51772 in use?`; the suite reports 0 fail and 1 error, and the logged runner exits 1. Run alone, the file reports 0 pass, 0 fail and the same error, three times in a row.
- **Cause:** the file imports `./index.js`, and importing it starts the bridge's HTTP server on `env.PORT` (`bridges/codex-bridge/src/index.ts`, default 4098). The shell ran inside an Orkestrator Claude tab, which exports `PORT=51772`: the port of the host app's own Claude bridge, which was listening on it. No other file in the suite reads `PORT` this way.
- **Rerun:** `env -u PORT mise run test:logged -- --name codex-bridge -- bun --cwd=bridges/codex-bridge test --parallel=2 --only-failures` passed with no change (exit 0, 12.0 seconds logged).
- **Workaround:** unset `PORT` before running bridge tests from an agent tab. A fix would stop `index.ts` listening on import (start the server only when it is the entry point), or have the test not import `index.ts`.
- **Evidence:** `orkestrator-test-run.1wtDRd/codex-bridge.log.gz` and `orkestrator-test-run.7ZzPWD/codex-bridge.log.gz` under the host temporary directory.
