# Node reconnect wake mail not yet delivered under load

- **ID:** 9962
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`.
- **Observed head:** `egress-name-checks-99a7933a4d12-r1` at `5cff101fa`. The
  branch changes `apps/web/src/components/environments/EnvironmentNetworkPolicyStatus*`,
  one line of `ServiceBrowserTab.test.tsx`, a daemon unit test and docs; it
  does not touch the backend or this test.
- **File:** `apps/backend/src/core/coordinator-node-reconnect-wakes.test.ts:390`
- **Test:** `NodeCoordination.onNodeConnected > listeners hear each node that connects or reconnects, once per transition`
- **Failure:** `expect(world.received(main)).toHaveLength(1)`, Expected
  length 1, Received length 0, after `await world.deliver()` (140.27 ms). The
  listener assertions just before it (`heard` equal to two connects) passed.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite, backend package at its default parallel worker count) on
  Linux x86_64, host load average about 61 to 72 on 16 cores from other
  worktrees' runs.
- **Suite counts:** backend 18,368 passed and 1 failed; desktop 2,033,
  protocol 5,817, toolchain 135, CLI 517, web-public 52, root and bridge
  groups passed; web had 9 failures, all in the open flake
  [9932](../native-agents-and-transcripts/9932-virtuoso-cancellation-fake-clock-timer-count.md).
- **Isolated rerun:** the aggregate runner's automatic rerun of the unchanged
  owning file reported `PASSED ALONE (1.8s)`.
- **Evidence:** `orkestrator-test-run.QABp0N/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Hypothesis

Unconfirmed. The mail the production reconnect subscription sends to the
main conversation's mailbox may not have been enqueued when `world.deliver()`
ran: `settle()` yields five microtasks, which is enough on a quiet host but
not if the subscription's send awaits real I/O (storage or a timer) that a
loaded host delays. Per the testing guide, reproduce it first (for example
under `scripts/test-under-contention.ts`) before changing the test, and await
the send itself rather than adding microtask rounds.

## Recurrence 2026-11-13

- **Branch:** `reviewer-failure-c64fd66ac37e-r1` at `b3807407a`, base
  `17d28238c`. `mise run flaky:recurrence -- 9962 --base 17d28238c` returned
  "open. Record the failure as a recurrence". The branch changes the
  structured review contract and review handling, not node coordination or
  agent mail.
- **Command:** the aggregate's workspace group run directly
  (`bunx turbo run build test:workspace ... --concurrency=2`,
  `ORKESTRATOR_BACKEND_TEST_WORKERS=4`) at load average about 100 on 16
  cores. Full command and counts are in
  [9995](../previews-annotations-and-gateway/9995-proxy-buffer-reservation-release-timeout-under-load.md).
- **Failure:** the same assertion at `coordinator-node-reconnect-wakes.test.ts:390`,
  Expected length 1, Received length 0 (59.10 ms).
- **Isolated rerun:** the owning file passed alone with one worker, in the
  same run as the gateway file.
