# Firewall name-check setup times out in the default aggregate

- **ID:** 6602
- **Status:** resolved
- **Previously:** 9834, renumbered on 2026-11-06 because three cases shared it (to-do 7142, retired 2026-11-10; see [number claims](../../../number-claims/README.md))
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

## Recurrence during storage/mail review, 2026-11-06

The same test failed at line 194 in the exact recorded-command rerun:

```sh
mise run test:logged -- --name review-default-tests -- mise run test
```

The root group used one worker alongside the workspace group (the bridge group
was still queued). At `ee92c4741`, `bootFixture` again returned a null exit code:
5,006.63 ms against the 5,000 ms deadline. Root totals were 3,746 pass, 4 fail,
3,750 tests in 196 files, with 380.34 s execution. The group started after a
705 s admission wait and finished 1,086 s into the aggregate run.

Evidence is in the logged runner's group directory
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KcOGqn`
(`root-and-agent-support-tests`), with the outer `review-default-tests` wrapper
in `orkestrator-test-run.uRCFAT` under the same temporary root.

The unchanged owning file then passed alone, exit 0 in 9.8 s:

```sh
mise run test:logged -- --name findings-firewall -- bun test ./tests/unit/firewall-egress-filter.test.ts --parallel=1 --only-failures
```

Passing output was removed by the runner; no isolated case counts are inferred.
The branch changes storage maintenance and mail dispatch, not the firewall
scripts or this test. No assertion, timeout or skip was changed. The isolated
pass confirms another intermittent failure; its cause remains unestablished.

### Recurrence: 2026-11-06, automatic account switching branch

Observed in the default aggregate on top of `ea8b13f5a`:

```sh
mise run test
```

This time `bootFixture` returned exit code 1 after 1,390 ms rather than a null
exit at the deadline, so the fixture failed rather than ran out of time. The root
group finished in 280.3 s; its other failures were unrelated
(`disposable-docker-daemon.test.ts` fails alone too, and the `dom-absence-scan`
and `test-suite-ownership` findings name files on `main`).

The unchanged owning file then passed alone, 10 pass and 0 fail:

```sh
bun test ./tests/unit/firewall-egress-filter.test.ts
```

The branch changes agent-account switching and its Settings views, not the
firewall scripts or this test. No assertion, timeout or skip was changed. The
fixture's stderr was not kept, so why it exited 1 is unestablished.

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
