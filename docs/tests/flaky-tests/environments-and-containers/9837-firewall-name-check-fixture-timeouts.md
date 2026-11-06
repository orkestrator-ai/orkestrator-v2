# Firewall name-check fixture timeouts

- **ID:** 9837
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause:** a budget mismatch, not a race in the firewall scripts. Every
  failing case runs a real firewall script (`init-firewall.sh`,
  `update-firewall.sh` or `network-policy-entrypoint.sh`) against bash stubs
  through `Bun.spawnSync`, so one run forks well over a hundred short
  processes. That costs 0.3–1 s on an idle Linux host and 1–3 s on an idle
  macOS host (the owners took 13–48 s alone there), and exceeds Bun's generic
  five-second test deadline when an aggregate saturates a macOS host, where
  fork/exec scales worst. At the deadline Bun kills the still-running
  `spawnSync` child ("killed 1 dangling process"), which is why every
  recurrence reports `exitCode` `null` rather than a script failure. The 0632
  and 0983 notes that the owner also fails alone at load average 15–35 fit
  the same cause. The fixtures stub `dig`, `curl` and `getent`, so no real
  DNS is involved.
- **Fix:** `tests/unit/firewall-test-support.ts` defines
  `SHELL_FIXTURE_TEST_TIMEOUT_MS` (30 s, the same budget the command fixtures
  use for real subprocess work), and `firewall-policy.test.ts`,
  `firewall-refresh.test.ts` and `firewall-egress-filter.test.ts` apply it with
  `setDefaultTimeout`, which Bun scopes to the file. No assertion changed.
  The same review fixed a second, latent race in the name-check boot fixture
  (`firewall-egress-filter.test.ts`): it cut the daemon readiness loop to
  three 0.1 s tries for the ready stub as well, so a `perl` start slower than
  0.3 s failed with exit 1 ("the name-check daemon did not start"). Only the
  never-ready case now shortens the loop. The ready case keeps the real loop,
  which returns as soon as the stub writes its file.
- **Reproduction:** `bun test tests/unit/firewall-egress-filter.test.ts
  --timeout 250` on the unchanged file gives the recorded signature exactly:
  `Expected: 0, Received: null`, "killed 1 dangling process". A 0.5 s delay
  added to the ready stub's `perl` start fails the unchanged boot case with
  exit 1, and passes once the fix is in. The five-second aggregate deadline
  itself was not reproduced on this Linux host, where the slowest case takes
  1 s.
- **Verification:** `mise run test:logged -- --name env-firewall-stress -- bun
  test tests/unit/firewall-egress-filter.test.ts tests/unit/firewall-policy.test.ts
  tests/unit/firewall-refresh.test.ts --parallel=3 --rerun-each=10`: PASS
  (630 test runs, 167.6 s) on the shared host at load average 24–33 while
  other agents' suites were running. One plain pass of the three files: 63
  pass, 0 fail.
