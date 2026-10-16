# Fake Codex subprocess probe times out under aggregate load

- **ID:** 0210
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

## Recurrence — 2026-10-16 (coordinator status-wake review fixes)

`mise run test:logged -- --name review-all-tests -- mise run test` repeated
this timeout at 5012.47 ms with one Codex bridge worker on the shared host.
The bridge group failed only this case; the other four bridge packages passed.
Evidence: `/tmp/orkestrator-test-run.stt8gO/bridges.log.gz` (compressed when
the aggregate completes).

`mise run test:logged -- --name review-codex-fixture-recheck -- bun test ./bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures`
passed unchanged alone in 0.4 seconds. No assertion or timeout was changed.
Concurrent host contention remains an unconfirmed hypothesis.
