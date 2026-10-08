# Stopped-reader tunnel queue exceeds its assertion under aggregate load

- **ID:** 0184
- **Status:** open
- **Date observed:** 2026-10-08
- **Test:** `PreviewTunnelServer > a stopped reader cannot grow the queue without bound`
- **File:** `apps/backend/src/preview-tunnel-server.test.ts:270`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
- **Worker configuration:** Aggregate groups used 2/3/2/1 slots; backend had one Bun worker alongside the web package.
- **Failure:** Expected `aggregateQueuedBytes <= 557056`; received `721158` after the stopped-reader delay (309.24 ms).
- **Suite counts:** Backend package: 5772 passed, 2 failed, 15 skipped (5789 total).
- **Isolated rerun:** Passed the owning file in 0.8 seconds, exit 0:

```bash
mise run test:logged -- --name preview-tunnel-rerun -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XzVEFK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The assertion samples queue accounting 300 ms after pausing a real WebSocket
reader. The isolated pass establishes intermittent behavior. Scheduling or
transport buffering may affect the sampled queue, but the observed failure does
not establish a root cause. No assertion, timeout or skip was changed.
