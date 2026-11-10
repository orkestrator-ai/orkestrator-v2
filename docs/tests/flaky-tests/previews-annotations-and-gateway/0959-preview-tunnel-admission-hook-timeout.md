# Preview tunnel admission case's hook times out in the aggregate

- **ID:** 0959
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `PreviewTunnelServer > admission bounds tunnels per service and releases on close`
- **File:** `apps/backend/src/preview-tunnel-server.test.ts:649`
- **Original command:** `mise run test` on `todo-0020-container-state-observation-fb5e330d3136` (`eea6142c0`: container image, entrypoint, an e2e spec, a CI workflow and docs; nothing in the preview tunnel), macOS 27.0 arm64, Bun 1.4.4, default worker plan; host load average about 18 to 22 from other workers.
- **Failure:** "a beforeEach/afterEach hook timed out for this test" at 5085.96 ms. Backend 11197 passed, 95 skipped and 2 failed across 11294 tests in 655 files (449.09 s); the other failure was case [0960](../coordinator-and-multi-review/0960-coordinator-node-launch-refusal-timeout.md). Every other group passed.
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PbLvVn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name tunnel-alone -- bun test --cwd apps/backend ./src/preview-tunnel-server.test.ts --parallel=1` passed (exit 0, 1.1 s).
- **Hypothesis:** a hook's server start or close exceeded five seconds under load. Unconfirmed; the previous `mise run test` on the same branch passed this file. No implementation, assertion, deadline or skip changed.

### Pipeline bell repair validation — 2026-11-02

`mise run test:logged -- --name repair-full -- mise run test` at `2617fd20d`
failed `PreviewTunnelServer > admission bounds tunnels per service and releases on close`
at 5277.08 ms (5-second deadline). Workspace reserved six worker slots.
Unchanged owner passed alone in 5.4 s:
`mise run test:logged -- --name repair-preview-owner -- bun test --cwd apps/backend ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures`.
Evidence: host temporary `orkestrator-test-run.Db1a7X/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed at finalization). Cause and target-branch independence remain unproven.

## Resolution (2026-11-10)

- **Root cause:** the suite's `beforeEach` built its `PreviewTunnelServer`
  with `helloTimeoutMs: 200` (production: `PREVIEW_TUNNEL_HELLO_TIMEOUT_MS`,
  5,000 ms), and the timer starts at the upgrade. When a loaded worker took
  more than 200 ms between the upgrade and the server reading the client's
  hello (the admission case opens 16 tunnels in a row), the server closed the
  tunnel with 4408, and the test's `ready()` waited on
  `nextControl("ready")`, which nothing ever settled, until Bun's 5-second
  deadline: the recorded 5,086 and 5,277 ms timeouts.
- **Fix:** `apps/backend/src/preview-tunnel-server.test.ts` builds the shared
  server with the production hello timeout; only the missing-hello part of
  `wrong credentials, missing hello, and browser origins are rejected` swaps
  in a 200 ms server, after its wrong-credential client (whose own 4401 had
  the same race) has finished. `nextControl` now rejects with the close code
  when the tunnel closes first, so a lost race fails at once and says why
  instead of hanging. No product code, assertion or test deadline changed.
- **Reproduced:** yes — a temporary `await Bun.sleep(250)` before `ready()`
  sends the hello made
  `mise run test:logged -- --name b39-0959-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 -t "admission bounds"`
  fail with `this test timed out after 5000ms` (5,118.60 ms). With the fix
  and the same delay the whole owner (18 tests) passed
  (`b39-0959-fixed-delay`).
- **Stress:** `mise run test:logged -- --name b39-0959-stress -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --rerun-each=20`
  passed (exit 0; macOS, burners unpinned, host load average about 47).
