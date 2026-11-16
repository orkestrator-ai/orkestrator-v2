# Relay read assertion after queued EOF

- **ID:** 0340
- **Status:** resolved
- **Retired:** 2026-11-15: the test and the tunnel v1 upstream pump it
  exercised, `PreviewTunnelServer.accept`, were removed with tunnel v1 by the
  legacy-retirement sweep (8108, retired); the tunnel carries every connection
  as a v2 stream with per-stream credit.
- **Date observed:** 2026-10-17
- **Test:** `PreviewTunnelServer > relay upstream preserves unshifted bytes and EOF across a stopped tunnel reader`
  in `apps/backend/src/preview-tunnel-server.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
  Workspace/root/bridge/protocol reserved 4/1/2/1 worker slots; backend used
  two isolated Bun workers. Workspace admission waited 251.3 seconds.
- **Failure:** the response closed normally, but `_read` was not called after
  resuming (expected at least one call, received zero, 68.28 ms). Backend:
  8,793 passed, 41 skipped, 2 failed across 471 files (401.33 seconds); the
  other failure was tracked Git cache case 0180. Aggregate duration: 723.0 s.
- **Isolated rerun:** `mise run test:logged -- --name tunnel-isolated-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures`
  passed all 17 unchanged tests (1.2 seconds logged).
- **Cause:** the fixture could deliver the whole response and EOF before the
  tunnel resumed. Once EOF is buffered, the stream legitimately needs no
  further `_read`, so the assertion depended on process/socket scheduling.
  Simply withholding the explicit `end()` was insufficient: the source socket
  automatically half-closed on the client's request EOF. That intermediate
  fixture failed 6 of 170 cases in a ten-run owning-file stress check.
- **Fix:** keep the source socket half-open, fill the upstream readable buffer,
  resume consumption and verify `_read` before explicitly sending EOF. The
  byte equality, queue bound, EOF, normal close, and cleanup checks remain.
- **Verification:** `mise run test:logged -- --name tunnel-final-credit -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures --rerun-each=10`
  passed all 170 tests (10.7 seconds logged), with no timeout or assertion relaxed.
- **Evidence:** original aggregate log
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ZmlX01/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  intermediate stress log `orkestrator-test-run.y5CBCy/tunnel-final.log.gz`
  under the same temporary root.

The subsequent full run (`mise run test:logged -- --name final-full-suite -- mise run test`)
passed all preview tunnel tests with two isolated backend workers. Its backend
failures were unrelated cases 0227 and 0341; root/support failed case 0178.
Evidence: `orkestrator-test-run.bXnknL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the same temporary root.

## Interactive command main merge — 2026-10-26

- **Original command:** `mise run test:logged -- --name merge-repository -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, including two backend workers. Component-browser validation also ran on the host.
- **Aggregate:** backend 11,960 passed, 141 skipped, 11 failed and seven errors across 719 files (1196.99 s); root/support 3,524 passed, four failed and one error (439.93 s). Aggregate exit 1 after 1354.0 s. Web passed all 9,937 active tests; bridges and protocol passed.
- **Evidence:** `orkestrator-test-run.uWXxA5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, `orkestrator-test-run.uWXxA5/root-and-agent-support-tests.log.gz`, and enclosing `orkestrator-test-run.doKdov/merge-repository.log.gz` below the host temporary directory.
- **Observation:** The relay/EOF case expected close code 1000, received 1001 (7839.11 ms). This differs from the earlier read-count assertion.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-tunnel-owner -- bun test --cwd apps/backend ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed (exit 0, 1.0 s).
- **Assessment:** Reopened after this aggregate-only recurrence; the current cause is unconfirmed. Earlier fix history remains valid for its documented failure. No implementation, assertion, deadline or skip changed.

## Investigation — 2026-11-10

Still open. Close code 1001 comes only from `PreviewTunnelServer.close()`,
which in this test runs from `afterEach`; so on 2026-10-26 the relay case was
still waiting at `await controlled.closed` after `source.end()` when Bun's
5-second deadline passed, and the 1001 is the teardown, not the cause. All
earlier waits had passed (every byte delivered, `_read` called). It did not
reproduce: the tcp and relay cases passed 200 of 200 under 12 unpinned
burners at host load about 47
(`mise run test:logged -- --name b39-0340-relay-100 -- bun scripts/test-under-contention.ts --burners 12 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --rerun-each=100 -t "upstream preserves unshifted"`),
each in under 0.25 s. The case 0959 fix (production hello timeout, a
`nextControl` that fails on close) does not touch this path, which builds
its own server through `controlledTunnel`. Next step: on a recurrence, log
whether the upstream ever emitted `end` (a paused upstream waiting on a
`drain` that never comes would hold EOF in its readable queue).

## Resolution (2026-11-15)

- **Class:** default budget (A), with the file's poll deadline widened as a watchdog.
- **Root cause:** per the 2026-11-10 investigation, the 2026-10-26 recurrence was the 5 s default expiring while the relay case awaited `controlled.closed`; the 1001 was `afterEach` teardown.
- **Fix:** `tests/default-test-timeout.ts` (a 60 s per-test and hook hang watchdog in both shared preloads, replacing Bun's 5 s default); `waitForTunnelCleanup` in `apps/backend/src/preview-tunnel-server.test.ts` now uses a 30 s `TUNNEL_WAIT_HANG_WATCHDOG_MS` instead of 2 s (all callers wait for states the tunnel reaches). If the upstream genuinely never emits `end`, it will now fail at the watchdog rather than pass, so a recurrence after this means a real hang.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker.
- **Stress:** `mise run test:logged -- --name b-cont -- bun scripts/test-under-contention.ts --core 2 --burners 6 -- bash -c 'cd apps/backend && bun test src/preview-tunnel-server.test.ts src/preview-publication.test.ts src/core/previews/local-discovery.test.ts src/core/previews/terminal-roots.test.ts --preload ../../tests/setup-node.ts --parallel=1 --rerun-each=3'` passed (59.7 s).
