# Firewall name-check fixture timeouts

- **ID:** 9837
- **Status:** open
- **Date observed:** 2026-11-06
- **Tests:** `init-firewall.sh with name checks > redirects TCP to allowed tuples and every DNS query to the daemon, and lets only marked traffic leave`; `update-firewall.sh --set-domains with name checks > stages DNS lookups while preserving current connection permissions until commit`
- **File:** `tests/unit/firewall-egress-filter.test.ts:194`, `:356`
- **Original command:** `cd '.' && mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** root and agent-support group, `1x PARALLEL`; workspace and bridge groups ran concurrently after a roughly 647 s scheduler wait.
- **Failure:** both fixture subprocess results had `exitCode: null` instead of `0`; Bun reported its 5,000 ms test deadline at 5,013.50 ms and 5,010.69 ms respectively.
- **Suite counts:** root and agent-support group: 3,674 passed, 3 failed, 3,677 total across 187 files in 249.54 s. The third failure is a separate packaged-Electron Linux-path assertion on macOS, not part of this case.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.w1gclF/root-and-agent-support-tests.log` (compressed after aggregate finalization); outer logged rerun directory `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nXBxh9/`.
- **Isolated rerun:** `mise run test:logged -- --name address-firewall-owner -- bun test ./tests/unit/firewall-egress-filter.test.ts --parallel=1 --only-failures` passed the entire owning file, exit 0, in 3.0 s. Passing output was deleted by the logged runner; individual passing counts were not retained.
- **Scope:** the triage repair branch changes neither this test nor the firewall implementation or its fixtures. No timeout or assertion was loosened.
- **Hypothesis:** none established. The isolated pass demonstrates intermittent behavior, but neither the aggregate timeout nor the concurrent workload establishes the cause.
