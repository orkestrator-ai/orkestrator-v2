# ACP harness talked to another server on its port and got 401

- **ID:** 0876
- **Status:** resolved
- **Date observed:** 2026-10-25 (CI run of 2026-10-23)
- **Test:** `ACP bridge > carries launch arguments across a rawInput patch that drops them`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:281`
- **Original command:** CI `main` run 40038837111 (#1202, 2026-10-23), job "Unit and integration tests", `mise run test` on `ubuntu-latest`; the bridges group ran ACP and Cursor bridge files at the same time.
- **Failure:** the first authenticated request after `spawnBridge` returned `401` instead of `202` (30.45 ms).
- **Occurrences:** 1 of the 44 failing `main` CI runs from 2026-10-23 to 2026-10-25.
- **Root cause:** `unusedPort()` (`bridges/acp-bridge/src/acp-test-harness.ts`) binds port 0, reads the port and closes the listener before the bridge child binds it, so another worker's server can take the port first. The child then exits on `EADDRINUSE`, but readiness polled only the unauthenticated `/global/health`, which the other server answered. The test then sent its token to that server, which refused it.
- **Reproduction (2026-10-25, macOS):** a temporary test bound a fake server to a port (health 200, everything else 401) and called `spawnBridge({ port })`. With the old harness, `spawnBridge` returned and `POST /session/create` answered 401: the CI symptom. With the fix it threw `ACP bridge exited while starting on port … (attempt 1)`.
- **Fix:** on branch `todo-0030-test-suite-ci-health-e11a519267e2`, readiness now needs the spawned child alive and `/global/auth-check` to accept this test's token. A child that exits while starting is replaced on a fresh port, up to three attempts. Only the port choice is retried; no test request is.
- **Verification:** the whole ACP package passed at `--parallel=4` (669 pass on the second run; the first run's only failure was case 0179, fixed in the same change).

- **Review follow-up (2026-10-25):** authentication alone still accepted a sibling using the harness's shared default token before the child lost its bind. Readiness now requires the spawned child's own post-bind stdout announcement before `/global/auth-check`. Startup timeouts also stop and deregister the child.
- **Regression coverage:** `src/acp-test-harness.test.ts` holds each released reservation with a same-token HTTP listener while the spawned bridge delays its bind. It covers fixed-port refusal without retry, two failed binds followed by success on the third fresh port, exhaustion after three failed binds, and a live child that never binds. Every failed child must be stopped and deregistered. The focused harness and Electron cleanup regressions pass with three parallel file workers; the real Electron `before-quit` hang regression passes under Playwright.
