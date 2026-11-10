# Shared observation fixture receives no HTTP requests in aggregate

- **ID:** 0672
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `NativeAgentService shared observations > observation never starts a bridge, hydrates or touches a session`, `apps/backend/src/core/native-agent-service-reconciliation.test.ts`.
- **Original command:** `mise run test:logged -- --name final-suite -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside other worktrees. Backend used two Bun workers.
- **Failure:** `expect(paths.length).toBeGreaterThanOrEqual(3)` received zero (12.86 ms). Activity reconciliation logged an error immediately before the assertion.
- **Isolated rerun:** `mise run test:logged -- --name observations-isolated -- bun test --cwd apps/backend ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (2.8 s logged, exit 0).
- **Suite counts:** backend: 9904 passed, 80 skipped, two failed and one between-test error across 9986 tests in 571 files (572.47 s); the other failure is tracked in 0291. Root/support, bridges and protocol passed.
- **Evidence:** `orkestrator-test-run.H9pUnY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; passing focused output was removed by `test:logged`.
- **Hypothesis:** the observation path failed or reused unavailable-provider state before reaching the fixture's HTTP server. Zero recorded requests supports a pre-HTTP failure, but the isolated pass does not identify its cause. No observation implementation, assertion, timeout or skip changed.

## Recurrence on 2026-11-05

- **Commit:** `44aed5fea` (E23 documentation citation repair; no observation code changes).
- **Aggregate command:** `mise run test:logged -- --name review-default-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 6/1/2/1 slots; the run waited about 490 s for the shared resource.
- **Failure:** the same `paths.length >= 3` assertion received zero at line 4595 (27.73 ms).
- **Counts:** backend 15,293 passed, 129 skipped, one failed across 15,423 tests in 1,026 files (278.58 s). Protocol also failed a separate release-install test; root/support, bridges and protocol-lockfile groups passed.
- **Isolated command:** `mise run test:logged -- --name observations-isolated -- bun test --cwd apps/backend ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 3.3 s).
- **Evidence:** aggregate output retained separately under `output/agent-testing/e23-address-findings/`; original temporary artifacts were `orkestrator-test-run.dJqqUH/review-default-tests.log.gz` and `orkestrator-test-run.tcoHaB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Conclusion:** recurrence of the existing aggregate-only fixture miss. Root cause remains unconfirmed; no assertion or product code changed.

### Investigation — 2026-11-06

- `mise run test:logged -- --name n0672-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-reconciliation.test.ts -t "observation never starts a bridge" --rerun-each=200` passed 200 times. The provider caches are per service instance, and `--parallel` isolates files, so neither a module-global cache nor another file's `mock.module()` explains zero requests. The remaining candidate is a pooled keep-alive connection to an earlier test's `Bun.serve` that bound the same ephemeral port. A stale pooled socket would fail the activity read before it reached the new server, which matches zero recorded paths, a logged reconciliation error and a 12-28 ms duration. Unconfirmed: the error text was not retained. Status stays open.

## Resolution (2026-11-10)

- **Root cause:** the fake bridge was shadowed by another process on the same
  port. The test started it with `Bun.serve({ port: 0 })` and no hostname,
  which listens on the dual-stack wildcard (`*:P`, IPv6 socket), while the
  service dials `http://127.0.0.1:P` (`observeBridgeConnection` in
  `apps/backend/src/core/native-agent-service.ts`). On macOS the kernel can
  hand out a wildcard port P that another process already holds as
  `127.0.0.1:P` (IPv4, `SO_REUSEADDR`), and the more specific listener answers
  `127.0.0.1:P`. The first sweep's activity read then reached a foreign server,
  failed `assertOk`, logged `activity.reconcile-failed`, and the fixture
  recorded zero paths: the recorded symptom. This is the mechanism case
  [0247](0247-activity-batch-sweep-no-requests.md) found, which named this
  fixture as remaining exposure.
- **Fix:** the fixture binds `hostname: "127.0.0.1"`, the address the service
  dials, so another process's `127.0.0.1:P` bind fails with `EADDRINUSE`
  instead of shadowing it. No assertion, timeout or product code changed.
- **Reproduced:** yes.
  - On this host, 3,000 `Bun.serve({ port: 0 })` listeners each fetched
    through `127.0.0.1` were answered by another process 7 times (and 5 of
    3,000 in a second run); `lsof` showed e.g. `bun *:55002` beside another
    `bun 127.0.0.1:55002`, and `bun *:56679` beside `opencode 127.0.0.1:56679`.
    With `hostname: "127.0.0.1"`, 0 of 3,000.
  - A temporary copy of the test started a Python squatter
    (`SO_REUSEADDR`, `127.0.0.1:<fixture port>`, answering 404). Before the
    fix it failed exactly as recorded: `[native-agent] activity.reconcile-failed
    ... at assertOk ... readProviderActivityObservation`, then
    `expect(paths.length).toBeGreaterThanOrEqual(3)` received 0. After the fix
    the squatter's bind failed with errno 48 and the test passed 5 of 5
    (`--rerun-each=5`, asserting the squatter's failure). The temporary code
    was removed.
- **Stress:** `mise run test:logged -- --name n0672-stress -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/native-agent-service-reconciliation.test.ts -t "observation never starts a bridge" --rerun-each=50'`
  passed; the whole owner with `--parallel=1` passed.
