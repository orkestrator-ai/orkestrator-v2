# Empty process group reported as live in aggregate validation

- **ID:** 9840
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `groupHasLiveMember > sees a running member and ignores an empty group`
- **Owner:** `packages/protocol/src/node/shell-process-state.test.ts:96`
- **Branch commit:** `1094f412b6960002ced018096dd0ba99faf8d2c5`
- **Aggregate command:** `cd '.' && mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** two isolated protocol workers (`2x PARALLEL`) within the concurrent workspace group; root and bridge groups also executing, after approximately 370 seconds queued for host capacity.
- **Failure:** the nonexistent group `2 ** 22 + 1` returned `true` rather than `false`, at 598.16 ms. Protocol: 4,981 passed, two skipped, one failed, 4,984 tests in 265 files, 48.93 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.3ZgUi8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed after aggregate finalization); outer wrapper directory `orkestrator-test-run.IBXph1` under the same temporary root.

## Isolated rerun

`mise run test:logged -- --name address-process-state -- bun --cwd=packages/protocol test ./src/node/shell-process-state.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`

The unchanged complete owner passed with exit 0 in 2.0 seconds. Passing output
was removed by the logged runner; individual passing counts were not retained.
No process-inspection implementation, test, timeout or skip changed. This branch
changes agent-tools listener selection and its regression tests; its protocol
change only adds a log event in `src/log-vocabulary/docker.ts`.

## Hypothesis

On macOS, `groupHasLiveMember` treats an unsuccessful process inspection as
unknown and returns `true`; its `ps` subprocess has a 100 ms timeout. That is a
possible explanation, but no subprocess failure or timeout was captured here.
The isolated pass establishes intermittence, not its cause. Leave this open.
