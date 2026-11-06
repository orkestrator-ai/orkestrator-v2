# Firewall name-check setup times out in the default aggregate

- **ID:** 7141
- **Status:** open
- **Previously:** 9834, renumbered on 2026-11-06 because three cases shared it ([todo 7142](../../../todo/cross-cutting/7142-red-lint-job-merged-unguarded.md))
- **Date observed:** 2026-11-06
- **Test:** `init-firewall.sh with name checks > redirects TCP to allowed tuples and every DNS query to the daemon, and lets only marked traffic leave`
- **Owner:** `tests/unit/firewall-egress-filter.test.ts`
- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
- **Commit:** `d81fd21ed`
- **Workers:** one isolated root worker; workspace and bridge groups run concurrently.
- **Failure:** 5005.19 ms against the 5000 ms deadline; line 194 expected exit 0 but received null from `bootFixture`.
- **Suite counts:** root 3,674 pass and three failures across 3,677 tests in 187 files (385.31 s execution); aggregate 1615.7 s including admission waits.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fvkr6h/root-and-agent-support-tests.log.gz`; outer wrapper `orkestrator-test-run.OXNmsh` under the same temporary root.

## Isolated rerun

```sh
mise run test:logged -- --name firewall-filter-isolated -- bun test tests/unit/firewall-egress-filter.test.ts --parallel=1 --only-failures
```

The complete unchanged owner passed with exit 0 in 2.7 s. Passing output was
removed by the logged runner, so isolated counts are not inferred. No firewall
code, test assertion, timeout or skip changed. The branch changes renderer
viewport restoration and its tests, plus qualification documentation.

## Hypothesis

The fixture's shell startup may exceed its five-second budget while other
suites run. Host load was not measured; the isolated pass establishes
intermittence, not the cause. This case remains open.
