# `Electron backend command registry > backend-owned diff statistics` scans time out under aggregate load (`tests/unit/electron/commands-integration.test.ts`)

- **ID:** 0162
- **Status:** open
- **Date observed:** 2026-09-25
- **Tests:** `computes counts for a tracked local environment and announces them`
  (8,100 ms) and `serves the Files panel from the scan the badge already ran`
  (7,710 ms), both reported as exceeding the 5,000 ms test timeout.
- **Original command:** `mise run test:changed` (recurring-processes step 10;
  root and agent-support group ran next to the workspace and bridge groups)
  on a shared host at load average 30–41. The root group reported 766 passed
  and 2 failed.
- **Isolated rerun:** `mise run test:logged -- --name root-diffstats -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** real git diff scans under heavy host contention exceed the
  generic five-second budget. The change under validation (bridge lifecycle,
  ACP disconnect detection, reconnect backoff) touches no diff-statistics
  code.
