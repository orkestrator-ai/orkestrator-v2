# Firewall root-entrypoint fixture times out in the aggregate

- **ID:** 0983
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `container firewall policy > the root entrypoint runs the firewall itself and records the outcome per mode`
- **File:** `tests/unit/firewall-policy.test.ts:806`
- **Original command:** `mise run test` on `todo-0112-review-fanout-recovery-0aecfac78013` (review fan-out runner, Claude and Codex bridge status fields, tests and docs; nothing under `docker/` or the firewall scripts), macOS arm64, Bun 1.4.4, standard worker leases; host load average 22 to 32.
- **Failure:** in both full runs of the day, after about 5,002 ms (Bun's five-second budget), `expect(result.exitCode).toBe(0)` at line 822 received `null`: the real shell harness had not exited when the deadline fired.
- **Suite counts:** root and agent-support tests 3,470 passed and 2 failed of 3,472 in 166 files (207 s); the other failure was the `flaky test register` index check, which fails deterministically on `main` because case 0887 has no `- **ID:**` line. Workspace, bridges and the Codex protocol lockfile groups passed.
- **Isolated rerun:** `mise run test:logged -- --name firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts` passed (37.8 s). Earlier in the day the complete owner also passed alone (34 passed).
- **Aggregate evidence:** `orkestrator-test-run.5Cv5CX` under the host temporary directory.
- **Recurrence (2026-10-26, after the Multi Review fixes):** the full run failed it again with eight other firewall shell-fixture deadlines (`firewall-policy.test.ts`, `firewall-refresh.test.ts`); rerunning both owners alone at load average 15 to 35 (`mise run test:logged -- --name firewall-owners -- bun test ./tests/unit/firewall-policy.test.ts ./tests/unit/firewall-refresh.test.ts`) still failed three different five-second cases, this one included (46 passed, 88 s). Under that load the owner fails alone too, as 0632 records for `main`; nothing in this branch touches the firewall scripts.
- **Hypothesis:** the same host-contention deadline as [0632](0632-firewall-policy-probe-budget.md) and [0192](0192-firewall-bootstrap-shell-timeout.md): the fixture runs the real entrypoint shell script, which does not finish within five seconds when the aggregate saturates the host. Unconfirmed. No firewall code, assertion, timeout or skip changed.

## Restart-status coverage validation — 2026-10-26

- **Command:** `mise run test`, workspace/root/bridge/protocol reservations 4/1/2/1.
- **Failure:** root-entrypoint deadline at 5002.92 ms, exit code `null`; the GitHub seed/live/cache case also timed out at 5009.12 ms (0192).
- **Root counts:** 3469 passed, 3 failed across 3472 tests in 166 files (230.78 s). The third failure is the existing missing ID metadata in registry case 0887, also reproduced alone.
- **Evidence:** `orkestrator-test-run.nG0pIs/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Owner rerun:** `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`: 33 passed, 1 failed (45.45 s). Both aggregate firewall cases passed; a different policy-3 HTTPS probe hit 5002.93 ms. Evidence: `orkestrator-test-run.jPtxw9`.
- **Assessment:** the complete owner still fails under current host conditions, so this observation does not establish a new flake classification. No firewall code, assertion or deadline changed.

## Interactive command/prompt review — 2026-10-26

- **Original command:** `mise run test` through `test:logged`, standard 4/1/2/1 workspace/root/bridge/protocol reservations.
- **Observation:** The root-entrypoint case timed out at 5007.31 ms. The complete unchanged owner passed alone in 42.2 s.
- **Owner command:** `mise run test:logged -- --name owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`.
- **Root/support counts:** 3,520 passed, four failed, one error across 3,524 tests in 170 files (438.46 s).
- **Evidence:** `orkestrator-test-run.pk3f2Z` (inner logs), outer wrapper `orkestrator-test-run.y6ZSym`, below the host temporary directory.
- **Assessment:** aggregate failure remains reported; assertions, timeouts and skips are unchanged.

## 0247 consolidated-review fixes — 2026-10-27

- **Original command:** `mise run test:logged -- --name review-fix-suite -- mise run test`, standard workspace/root/bridge/protocol reservations 4/1/2/1 on the shared macOS host.
- **Observation:** the unchanged root-entrypoint case timed out at 5006.66 ms, receiving `exitCode: null`. Root/support finished with 3,530 passed and three failed across 3,533 tests in 171 files (293.53 s); the other two failures are the recorded migration-copy assertions.
- **Owner command:** `mise run test:logged -- --name review-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed in 21.6 s.
- **Evidence:** inner `orkestrator-test-run.S3DyLI/root-and-agent-support-tests.log`, enclosing `orkestrator-test-run.OHbyVm/review-fix-suite.log` under the host temporary directory (compressed on finalization).
- **Assessment:** recurrence of the existing aggregate deadline; no firewall code, assertion, timeout or skip changed.

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
