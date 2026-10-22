# Claude bridge plan-exit persistence under the aggregate suite

- **ID:** 0513
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted`
- **File:** `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:846`
- **Original command:** `mise run test:logged -- mise run test:changed` (command-node M3 run; the bridges group ran concurrently with the workspace group).
- **Worker configuration:** default `scripts/test-all.ts` planning on the development Mac; worker counts not captured.
- **Failure:** the test failed after 1.43 ms in the aggregate run, with session-manager prompt-settle errors logged around it.
- **Isolated rerun:** `bun test src/services/session-manager-interactions.test.ts` from `bridges/claude-bridge` passed three times in a row (29 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.gQwlaB` under the host temporary directory.
- **Hypothesis:** ordering or timing between interaction cleanup and the failed-turn settle under host load. The change under test (command nodes) does not touch the bridges; `git diff main -- bridges` is empty. No implementation, assertion, timeout or skip changed.

## Federated client main merge — 2026-10-21

`mise run test:logged -- --name merge-full -- mise run test`, merging
`origin/main` into pre-merge HEAD `723e2d9e`, repeated the approved-exit case
at 1.44 ms with `EISDIR` opening the fixture's `.claude` directory. The
workspace/root/bridges/protocol groups reserved 4/1/2/1 slots; the Claude
package used one isolated Bun worker. Claude reported 1,600 passed, five
skipped and one failed across 76 files (39.85 seconds). Browser and Electron
validation were also running on the host.

`mise run test:logged -- --name merge-claude-owner -- bun test --cwd
bridges/claude-bridge --preload ../../tests/setup-node.ts
./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures`
passed the entire unchanged owner, exit 0 in 1.2 seconds. Evidence:
`orkestrator-test-run.0OlBGi/bridges.log.gz` below the host temporary directory.
This confirms an intermittent recurrence; the fixture ordering or contention
cause remains unconfirmed. No implementation, assertion, timeout or skip changed.

## Remote workspace refreshed main merge — 2026-10-21

- **Command:** `mise run test:logged -- --name refresh-tests -- mise run test`, merging main `f228a6aa9` into pre-merge HEAD `aade0bcd5`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one isolated Claude worker, alongside component and isolated-stack browser validation.
- **Failure:** the same fixture write failed with `EISDIR` at line 863 (3.64 ms). Claude reported 1600 passed, five skipped and one failed across 76 files (60.19 seconds); the other bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name refresh-claude-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 0.2 seconds logged).
- **Evidence:** `orkestrator-test-run.Qv1f63/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence. No bridge implementation, assertion, timeout or skip changed.
