# Change-tracking deadline wall-clock bound under aggregate load

- **ID:** 0512
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `foreground and queued deadlines settle while inventory is blocked and fence late publication`
- **File:** `apps/backend/src/core/change-tracking/review-regressions.test.ts:142`
- **Original command:** `mise run test:logged -- --name federation-tests -- mise run test` (complete non-iOS suite; the backend `test:workspace` group ran concurrently with the root, bridge and protocol groups).
- **Worker configuration:** default `scripts/test-all.ts` planning on the development Mac; worker counts not captured.
- **Failure:** `expect(Date.now() - started).toBeLessThan(300)` received 360 ms; the test took 1882 ms in the aggregate run.
- **Suite counts:** backend `test:workspace` reported 1 fail; exact pass counts were not captured.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/change-tracking/review-regressions.test.ts` from `apps/backend` passed (21 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.j9cRI6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Hypothesis:** the 300 ms wall-clock bound on two 30–40 ms capture deadlines is exceeded when the host is saturated by the concurrent suite groups. The change under test (federated multi-backend client) does not touch change tracking. No implementation, assertion, timeout or skip changed.
