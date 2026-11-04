# Preview ingress metrics timer misses first-byte measurement under aggregate load

- **Status:** open
- **Observed:** 2026-11-04 during subagent model review repair.
- **Owner:** `apps/desktop/tests/preview-transport-manager.test.ts`
- **Test:** `PreviewTransportManager (desktop tunnel end to end) > buffered ingress metrics are reported on a timer while the window stays open`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`; desktop used two parallel workers.
- **Failure:** after 136.46 ms, the metrics flush had `desktop.connect_ms` but
  lacked the expected `desktop.first_byte_ms` histogram. Workspace reported
  11 successful tasks out of 13; root, bridges and protocol passed. The other
  workspace failure was the recorded zsh completion timeout (case 1250).
  Aggregate duration was 974.8 seconds, including about 544 seconds queued.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Nq27Lg/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name preview-transport-isolated -- bun test --cwd apps/desktop ./tests/preview-transport-manager.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed in 1.4 seconds.
- **Assessment:** the first-byte event may have missed the observed timer flush
  under aggregate load; this is a hypothesis, not an established root cause.
  No implementation, assertions, deadlines or skips in this owner changed.
