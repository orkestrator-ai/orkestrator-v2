# Codex HTTP harness readiness timeout

- **ID:** 0148
- **Status:** resolved
- **Date observed:** 2026-09-19
- **Test:** `app-server engine over HTTP > serves the whole session lifecycle
  through the real routes` (`bridges/codex-bridge/src/app-server-http.test.ts:82`)
- **Original command:** `mise run test`
- **Worker configuration:** bridge group under the host-capacity runner; Codex
  used one Bun worker while other repository groups also ran.
- **Failure:** expected no harness error, received `app-server did not become
  ready within 5 seconds (last state: starting)` after 5,160.19 ms.
- **Suite counts:** Codex bridge: 1,799 total, 1,781 passed, 17 skipped, 1
  failed.
- **Isolated rerun:** `mise run test:logged -- --name codex-app-server-http --
  bun test ./bridges/codex-bridge/src/app-server-http.test.ts --parallel=1
  --only-failures` → passed in 6.0 s.
- **Hypothesis:** the real Bun harness and fake app-server child were runnable
  but did not complete their handshake inside the positive path's five-second
  readiness window while the host was busy.
- **Root cause:** the same five-second harness deadline served both successful
  spawned-child tests and the negative never-initializes test.
- **Fix:** make the test-only harness deadline configurable, use 15 seconds for
  positive startup, and preserve the five-second deadline and diagnostic
  assertion for the deliberate no-initialize case.
- **Verification:** the owning file passed after the fix in 6.0 s; `mise run
  test` then passed all four groups under the full eight-worker host budget in
  142.3 s, and `mise run test:all` subsequently passed those groups plus iOS.
