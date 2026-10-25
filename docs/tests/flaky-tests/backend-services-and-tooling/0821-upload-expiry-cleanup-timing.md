# Abandoned upload expiry cleanup races a fixed wait

- **ID:** 0821
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `abandoned uploads expire and remove worktree temporary files`
- **File:** `apps/backend/src/core/nodes/node-files.test.ts:343`
- **Change under test:** Multi Review dispatch recovery and result-reminder coverage, commits `8410fe29c` and `1834edeaa`.
- **Original command:** `mise run test:logged -- --name default-suite -- mise run test`.
- **Aggregate result:** the backend reported 11,184 passed and two failed. One failure was an older fan-out fixture missing request acceptance proof, corrected separately. The upload-expiry failure found a `.orkestrator-upload-` temporary file after the test's fixed 30 ms wait with a 10 ms expiry (159.02 ms test duration). The complete aggregate ran for 1,013.1 s, using the default workspace/root/bridge/protocol reservations of 4/1/2/1.
- **Unchanged owner rerun:** `mise run test:logged -- --name upload-expiry-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-files.test.ts --parallel=1 --only-failures` passed (exit 0, 0.8 s).
- **Evidence:** `orkestrator-test-run.MJ1vdw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.pnyrDq/`, under the host temporary directory.
- **Hypothesis:** the expiry timer and asynchronous temporary-file removal did not finish before the fixed assertion wait under aggregate contention. The isolated pass establishes intermittence; the cause is not established. No upload implementation, assertion, timeout, or skip was changed.
