# Relay read assertion after queued EOF

- **ID:** 0340
- **Status:** resolved
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
