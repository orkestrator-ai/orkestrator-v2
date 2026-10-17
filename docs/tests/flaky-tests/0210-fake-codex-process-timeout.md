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

Recurred on 2026-10-16 at 5066.71 ms in `mise run test` for the coordinator
launch-defaults change (no bridge code touched). The unchanged owning file
passed alone (2 pass, 0 fail). Evidence: `/tmp/orkestrator-test-run.k2ySO0/bridges.log.gz`.

## Recurrence — 2026-10-17 (pane reset review fixes)

`mise run test:logged -- --name full-suite -- mise run test` hit the same
5000 ms timeout with four workspace, one root, two bridge and one protocol
worker slots while browser validation and other worktrees used the host.
The other four bridge packages passed. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/bridges.log.gz`
(compressed when the aggregate completes).

`mise run test:logged -- --name fake-codex-isolated -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures`
passed the unchanged owner in 0.2 seconds. No assertion, timeout or skip changed.

## Recurrence — 2026-10-17 (service preview re-baseline)

Recurred on 2026-10-17 at 5000.00 ms in `mise run test` for the service
preview re-baseline (GNU-tool PATH prefix, macOS arm64, Bun 1.4.3; no bridge
code touched). Codex bridge: 2,144 passed, 31 skipped, 1 failed across 78
files; the other four bridge packages passed. `bun test ./src/testing/fake-codex-app-server.test.ts`
in `bridges/codex-bridge` passed the unchanged owning file alone (2 pass,
0 fail, 82 ms). Evidence: `orkestrator-test-run.mVA1hD/bridges.log.gz` in the
macOS temporary directory.
