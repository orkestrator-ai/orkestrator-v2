# EnvironmentItem copy-address tooltip stalls in the aggregate

- **ID:** 0671
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `EnvironmentItem copy address > clicking localhost address in tooltip copies to clipboard`
- **Owning file:** `tests/unit/components/EnvironmentItem.test.tsx`
- **Original command:** `mise run test:logged -- --name recurring-full-suite -- mise run test`
- **Worker configuration:** default aggregate workspace/root/bridges/protocol groups; root group reserves one worker on this host.
- **Failure:** tooltip text never contained `Created:`; reported test duration 987490.90 ms. The root group's no-progress watchdog also fired after 300000 ms without output. Aggregate exited 1 after 1095.2 seconds; workspace independently stalled in the Chromium executable-document policy test. Complete root counts were unavailable because the group was terminated.
- **Isolated rerun:** `mise run test:logged -- --name environment-item-isolated -- bun test ./tests/unit/components/EnvironmentItem.test.tsx --parallel=1 --only-failures` passed the complete unchanged owning file (exit 0, 4.5 seconds logged).
- **Evidence:** `orkestrator-test-run.GB1K1o/recurring-full-suite.log.gz` and the inner aggregate's `orkestrator-test-run.IGYJrv` below the host temporary directory.
- **Hypothesis:** delayed timers or host scheduling are plausible given the simultaneous long stalls in independent groups; no specific cause is established. No tooltip implementation, assertion, timeout or skip changed.
