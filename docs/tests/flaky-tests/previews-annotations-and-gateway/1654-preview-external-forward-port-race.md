# External preview forwarding loses a probed IPv6 port

- **ID:** 1654
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `PreviewExternalForward > a local server on :: keeps its traffic and port`
- **File:** `apps/desktop/tests/preview-external-forward.test.ts:281`
- **Original command:** `mise run test:logged -- --name retry-full-suite -- mise run test`
- **Worker configuration:** Bun 1.4.4 on macOS arm64; aggregate workspace tasks use concurrency 2; the desktop task uses `--parallel=${ORKESTRATOR_TEST_WORKERS:-2}` (the resolved desktop worker count was not captured).
- **Failure:** `Failed to start server. Is port 64070 in use?`, in 0.34 ms. The desktop group reported 1,488 passed, one failed, 1,505 total in 25.15 s.
- **Isolated rerun:** `mise run test:logged -- --name preview-forward-isolated -- bun test --cwd apps/desktop ./tests/preview-external-forward.test.ts --parallel=1 --only-failures` passed the complete owning file in 0.4 s.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.VOiuDB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** `freePort()` probes port 0 on `127.0.0.1`, closes the socket, then the test binds `::` to the returned port. Another listener can claim that port during the gap, or already occupy it on an address the probe did not check. The occupying process was not captured. This resembles case 1410 in a different owning test. No preview source or tests changed in this repair.

### Resolution — 2026-11-06

**Root cause.** Time-of-check race, as hypothesised: `freePort()` probed a
port on `127.0.0.1`, released it, and the decoy then bound that number on its
own address (`127.0.0.1`, `::1`, `0.0.0.0` or `::`). Another worker's
listener or client socket could take the port in the gap, and the probe never
checked `::` at all.

**Fix.** `apps/desktop/tests/preview-external-forward.test.ts`: the decoy
binds port 0 on its own address and the test uses the port the kernel gave
it, so there is no gap. Assertions unchanged.

**Not reproduced** (no gap left to hit). The remaining `freePort()` callers in
this file still probe; only `uses one port on both loopback families…` needs
the probed port itself to be free and keeps a small window. It has no
recorded failure.

**Verification.** `NODE_ENV=test mise run test:logged -- --name pef-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-external-forward.test.ts --rerun-each=20`: PASS, plus the three-file `--parallel=2 --rerun-each=5` run: PASS.
