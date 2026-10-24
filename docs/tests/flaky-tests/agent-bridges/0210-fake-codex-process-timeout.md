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

## Electron preview main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test` repeated the version/invocation timeout at 5074.82 ms. The unchanged owning file passed with `mise run test:logged -- --name merge-codexfake-owner -- bun test ./bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` (exit 0, 1.1 seconds). Aggregate evidence: `orkestrator-test-run.ItrRrn/bridges.log.gz` below the host temporary directory. No implementation, assertion, timeout or skip changed.

## Main merge validation — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, aggregate reservations 4/1/2/1; one worker for the owning package/group.
- **Observation:** 5,000 ms timeout; owning file passed unchanged in 0.1 s.
- **Owning-file rerun:** `mise run test:logged -- --name merge-rerun-fake-codex-app-server -- bun test --cwd bridges/codex-bridge ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` (exit 0).
- **Evidence:** `orkestrator-test-run.LitzDV/bridges.log.gz`; root group had 3051 passed, 1 skipped and 4 failed, including the separate README installer-link regression; Codex group had 2227 passed and 4 failed.
- **Assessment:** Confirmed recurrence; no implementation, assertion, skip or timeout changed.

## CLI matrices main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, macOS arm64 and Bun 1.4.3; workspace/root/bridges/protocol used 4/1/2/1 worker slots alongside the component browser suite.
- **Failure:** `fake Codex app-server process > reports its version and rejects unsupported invocations` exceeded its 5000 ms deadline (5001.20 ms). The other four bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-codex-owner-node -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed unchanged (2 passed, 0 failed, 0.2 seconds logged).
- **Diagnostic caveat:** an earlier root-directory invocation without the bridge's Node preload repeated the timeout (1 passed, 1 failed; 5.8 seconds), so it was not an equivalent isolated bridge check.
- **Evidence:** `orkestrator-test-run.qE7Fuy/bridges.log.gz` and `orkestrator-test-run.SqUuYH/merge-fake-codex-owner.log.gz` below the host temporary directory.
- **Assessment:** the equivalent isolated pass confirms intermittence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

Aggregate result: exit 1 after 664.7 seconds logged. Codex bridge reported 2230 passed, 34 skipped and this one failure across 2265 tests; all other bridge packages passed.

## Async question prefix review recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name complete-suite -- mise run test`, with workspace/root/bridges/protocol reservations of 4/1/2/1 worker slots; browser validation also ran on the shared host.
- **Failure:** the version/invocation case exceeded its 5000 ms deadline (5017.17 ms). The other four bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name codex-fake-process-node-recheck -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed unchanged (0.2 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LC3ZRI/bridges.log.gz` (compressed when the aggregate completes).
- **Assessment:** confirmed recurrence; no implementation, assertion, timeout or skip changed.


## OpenCode sign-in main merge — 2026-10-19

- **Scope:** `origin/main` at `cd443028` merged into pre-merge HEAD `d897a4eb`; no Codex bridge source or test changed.
- **Original command:** the testing guide's macOS GNU-tool PATH prefix with `/opt/homebrew/bin:/usr/bin` ahead of ambient shims, `mise run test:logged -- --name merge-tests -- mise run test`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside component and isolated-stack browser validation.
- **Failure:** `fake Codex app-server process > reports its version and rejects unsupported invocations` exceeded 5000 ms (5000.00 ms) in `bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts`.
- **Owning-file rerun:** the same PATH with `mise run test:logged -- --name merge-codex-fake-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.2 seconds logged).
- **Suite counts:** Codex reported 2230 passed, 34 skipped and one failed across 2265 tests in 82 files (49.00 seconds). The other four bridge packages passed; the bridge group finished in 164.5 seconds.
- **Evidence:** `orkestrator-test-run.tW4jss/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence. Concurrent subprocess load is a hypothesis; no implementation, assertion, timeout or skip changed.

## Remote sidebar reorder review recurrence — 2026-10-21

- **Original command:** `mise run test:logged -- --name reorder-suite -- mise run test`, default workspace/root/bridges/protocol reservations of 4/1/2/1, on the shared macOS host.
- **Failure:** the version/invocation case exceeded its 5000 ms deadline (5063.14 ms). The other four bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name reorder-codex-fake-node-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.2 seconds logged).
- **Evidence:** `orkestrator-test-run.U6kMZC/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence; host contention remains a hypothesis. No implementation, assertion, deadline or skip in the owner changed.

## Claude revision-token third main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name revtok-main3-tests -- mise run test`; workspace/root/bridges/protocol reservations 4/1/2/1 alongside browser and Electron checks.
- **Failure:** the version/invocation case timed out at 5027.15 ms. Codex reported 2242 passed, 34 skipped and one failed across 84 files (49.14 s); the other four bridge packages passed.
- **Unchanged whole owner:** `mise run test:logged -- --name revtok-main3-codex-owner-node -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed in 0.2 s. A root-preload diagnostic invocation also passed (0.8 s).
- **Evidence:** `orkestrator-test-run.YKWNcv/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed recurrence; concurrent subprocess scheduling remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Released Claude wakeup validation — 2026-10-23

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, one Codex worker, alongside isolated browser validation and other worktrees.
- **Failure:** the version/invocation test timed out at 5002.54 ms. Codex reported 2254 passed, 38 skipped, 2 failed across 84 files (59.49 s); the other failure was the event-byte estimator's 50 ms timing assertion.
- **Unchanged owner:** `mise run test:logged -- --name codex-process-node -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed (exit 0, 0.2 s logged).
- **Evidence:** `orkestrator-test-run.XHMi6K/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed recurrence; subprocess scheduling under shared-host load remains a hypothesis. No assertion, timeout or skip changed.


## Multi Review divider review validation — 2026-10-24

- **Original command:** `mise run test:logged -- --name resize-aggregate -- mise run test`; default workspace/root/bridges/protocol reservations 4/1/2/1, one Codex worker, alongside the component browser suite.
- **Failure:** `fake Codex app-server process > reports its version and rejects unsupported invocations` in `bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts` timed out at 5000.00 ms. The other four bridge packages passed.
- **Suite counts:** Codex reported 2303 passed, 40 skipped and one failed across 2344 tests in 86 files (31.19 s); the bridge group finished in 181.1 s.
- **Unchanged owner:** `mise run test:logged -- --name codex-fake-server-node-rerun -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/testing/fake-codex-app-server.test.ts --parallel=1 --only-failures` passed (exit 0, 2 passed, 0 failed, 0.2 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bqXLeN/bridges.log.gz` after aggregate completion.
- **Assessment:** confirmed recurrence; subprocess scheduling under concurrent host load remains a hypothesis. No bridge implementation, assertion, timeout or skip changed.
