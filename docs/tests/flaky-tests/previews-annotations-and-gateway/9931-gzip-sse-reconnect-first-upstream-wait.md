# Gateway gzip SSE reconnect: first request did not reach upstream in 2 s

- **ID:** 9931
- **Status:** open
- **Date observed:** 2026-11-10

Test: `gzip proxied event stream directly > a reconnect sends its cursor upstream and starts a fresh gzip stream`
in `apps/backend/tests/gateway-sse-gzip-routes.test.ts`.

No existing index entry matched this test or file; this records a new case,
not a counted recurrence.

## Observation

- **Branch:** `fix-failing-ci-7f55df7c3a91-r1`, base `2aad83a37` (`main`).
  The run's working tree only added two files to the root test group's path
  list and changed nothing under `apps/backend`.
- **Original command:**
  `mise run test:logged -- --name full-suite -- mise run test` (default tier,
  all groups concurrently on the local Linux host).
- **Failure:** `Proxy never reached the upstream`, thrown by `waitUntil`
  (`apps/backend/tests/gateway-test-harness.ts:324`, default 2,000 ms) at the
  test's first wait (line 711), 2,115.22 ms. The stream was opened through a
  freshly started gateway; the upstream had recorded no response yet.
- **Counts:** backend 18,238 passed, 147 skipped, 1 failed; 18,386 tests
  across 1,254 files in 410.48 s. The workspace group ran 517.8 s beside the
  web package's 993-file run (490.18 s). Evidence:
  `orkestrator-test-run.KeMHDa/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Isolated rerun

The unchanged owner passed alone, exit 0, 6.2 s (passing output removed;
counts not retained):

```sh
mise run test:logged -- --name gzip-sse -- bun --cwd=apps/backend test ./tests/gateway-sse-gzip-routes.test.ts --preload ../../tests/setup-node.ts --parallel=1
```

## Assessment

The first proxied request through a new gateway took longer than the
harness's 2 s default under aggregate load. Whether the delay was in the
gateway's route open, the proxy's upstream connect or the test host is
unconfirmed. The same file did not fail in the CI runs reviewed for this
branch. No budget, assertion or retry was changed for this record.

## Next evidence

If it recurs, record which phase the proxy reached (route open, upstream
connect, first byte) before changing the 2 s default; a slow-machine user
reconnecting would see the same delay.
