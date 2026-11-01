# External preview forwarding loses a probed IPv6 port

- **ID:** 1654
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `PreviewExternalForward > a local server on :: keeps its traffic and port`
- **File:** `apps/desktop/tests/preview-external-forward.test.ts:281`
- **Original command:** `mise run test:logged -- --name retry-full-suite -- mise run test`
- **Worker configuration:** Bun 1.4.4 on macOS arm64; aggregate workspace tasks use concurrency 2; the desktop task uses `--parallel=${ORKESTRATOR_TEST_WORKERS:-2}` (the resolved desktop worker count was not captured).
- **Failure:** `Failed to start server. Is port 64070 in use?`, in 0.34 ms. The desktop group reported 1,488 passed, one failed, 1,505 total in 25.15 s.
- **Isolated rerun:** `mise run test:logged -- --name preview-forward-isolated -- bun test --cwd apps/desktop ./tests/preview-external-forward.test.ts --parallel=1 --only-failures` passed the complete owning file in 0.4 s.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.VOiuDB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** `freePort()` probes port 0 on `127.0.0.1`, closes the socket, then the test binds `::` to the returned port. Another listener can claim that port during the gap, or already occupy it on an address the probe did not check. The occupying process was not captured. This resembles case 1410 in a different owning test. No preview source or tests changed in this repair.
