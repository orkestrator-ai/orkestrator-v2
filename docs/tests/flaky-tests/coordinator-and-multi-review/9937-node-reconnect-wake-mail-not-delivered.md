# Node reconnect wake mail not yet delivered under load

- **ID:** 9937
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
