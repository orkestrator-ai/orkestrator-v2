# Fake Codex subprocess probe times out under aggregate load

- **ID:** 0208
- **Status:** open

Observed: 2026-10-14

- Test: `fake Codex app-server process > reports its version and rejects unsupported invocations`
- Owner: `bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts`
- Original command: `mise run test:logged -- --name full-tests -- mise run test`
- Worker configuration: four aggregate groups; Codex bridge used one Bun worker while other host validations ran.
- Failure: default 5000ms timeout, observed duration 5071.20ms.
- Codex package result: 2009 pass, 22 skip, 2 fail in 40.45 seconds. The other failure was an absent pinned Codex binary, an environment prerequisite subsequently installed.
- Evidence: `/tmp/orkestrator-test-run.H9WZ9L/bridges.log.gz`.
- Isolated rerun: `mise run test:logged -- --name fake-codex-isolated -- bun test ./bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed unchanged in 0.2 seconds.

Hypothesis: subprocess scheduling or startup delay under concurrent host load exceeded the fixed deadline. The test source was neither changed nor skipped.
