# Isolated browser runner cases time out under aggregate load (`apps/desktop/scripts/dev/isolated-browser.test.ts`)

- **ID:** 0163
- **Status:** open
- **Date observed:** 2026-09-25
- **Tests:** `full task runs the whole configured suite and preserves Playwright failure`,
  `a profile exit during Playwright terminates the test process and cleans up`,
  `cleanup failure cannot report a passing run`, and
  `browser timeout is bounded and still resets the profile`: each timed out at
  about 5,005 ms. Follow-on errors in the same file included
  `Isolated profile cleanup failed for qa-browser-…` and unmet `toThrow`
  expectations.
- **Original command:** `mise run test:changed` (recurring-processes step 10),
  workspace group, desktop package: 123 passed and 4 failed of 127 in 44.1 s,
  on a shared host at load average 30–41.
- **Isolated rerun:** `mise run test:logged -- --name desktop-isolated -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/isolated-browser.test.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** the runner cases spawn real child processes whose teardown
  exceeds the generic five-second budget under heavy host load. The change
  under validation does not touch the desktop dev scripts.

## Move-fix validation recurrence — 2026-10-12

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name move-committed-suite -- mise run test` on code commit `bc8200e0`; standard 2/3/2/1 group slots, after all test profiles were stopped/reset.
- **Failure:** `full task runs the whole configured suite and preserves Playwright failure` timed out at 5001.90 ms, followed by one unhandled error. Desktop reported 169 passed, one failure and one error of 170 tests across 13 files; Turbo cancelled the rest of the workspace group.
- **Isolated rerun:** `mise run test:logged -- --name move-desktop-runner-isolated -- bun test ./apps/desktop/scripts/dev/isolated-browser.test.ts --parallel=1 --only-failures` passed unchanged in 17.9 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.0yj1Mb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (compressed after the aggregate finishes).
- **Hypothesis:** the existing subprocess deadline sensitivity remains plausible. The isolated pass does not identify the stalled operation; no assertion, timeout or skip was changed.

## Final attachment-fence validation — 2026-10-12

The final `mise run test:logged -- --name move-final-complete-suite -- mise run test`
on `07c59479` again stopped the workspace group on this unchanged owner. This
run affected `a profile exit during Playwright terminates the test process and
cleans up` (5001.78 ms) and `cleanup failure cannot report a passing run`
(5000.95 ms). The complete owner had passed independently in 17.9 seconds in
the immediately preceding validation; its source was not changed. Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.iZ6SFL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
Root/support reported 5004 passed, 24 skipped, 11 failed and five errors; bridges
and the protocol lockfile passed. The root failures are retained as failed
validation, not classified as flakes solely from this run.

## Agent accounts qualification validation — 2026-10-26

`mise run test` on the todo 0003 branch at `93018933` timed out three
`isolated browser overrides an inherited live … opt-in` cases (design,
idle-observation, revision-token; 5002 to 5012 ms) at host load 20 to 40. The
complete unchanged owner passed alone in 9.0 s. Recorded with the rest of that
run in [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md).
