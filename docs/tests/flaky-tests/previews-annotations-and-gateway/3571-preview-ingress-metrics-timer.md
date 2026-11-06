# Preview ingress metrics timer misses first-byte measurement under aggregate load

- **ID:** 3571
- **Status:** resolved
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

## Recurrence, 2026-11-05

Git mirror review preparation (`mise run test`, workspace group) missed the
first-byte histogram at 165.65 ms. The unchanged complete owner passed alone:
`mise run test:logged -- --name recorded-desktop-failure -- bun test --cwd
apps/desktop ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures`
(exit 0, 11.2 s). Original evidence remains in the review package's
`validation-04.stdout.txt`; no assertion or timeout was changed.

### Resolution — 2026-11-06

**Root cause.** An ordering assumption in the test. The manager's report
timer (`metricsReportMs: 20` here) starts at the first buffered sample, which
is `desktop.connect_ms` when the tunnel stream opens; `desktop.first_byte_ms`
is observed later, when the response's first byte arrives. Whenever the first
byte lands more than one interval after the connect, the samples go out in two
consecutive reports, and the test, which demanded both histograms in
`reports[0]`, failed with only `connect_ms`. The product behaviour (two
bounded reports) is correct.

**Reproduced.** A temporary copy of the unchanged test with
`metricsReportMs: 1` failed 10 of 10 (`--rerun-each=10`) with the recorded
signature (missing `desktop.first_byte_ms`).

**Fix.** `apps/desktop/tests/preview-transport-manager.test.ts` waits until
the first-byte sample has been reported, then asserts exactly one
`connect_ms` and one `first_byte_ms` sample across the one or two reports,
and that disposal sends nothing further (a rejected report is still not
retried).

**Verification.**
- The 1 ms copy of the fixed test: 20 of 20 passed.
- `NODE_ENV=test mise run test:logged -- --name ptm-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-transport-manager.test.ts -t "buffered ingress metrics|hiding does not close" --rerun-each=20`: PASS.
- Three-file `--parallel=2 --rerun-each=5` run with the external-forward and tunnel-client owners: PASS.
