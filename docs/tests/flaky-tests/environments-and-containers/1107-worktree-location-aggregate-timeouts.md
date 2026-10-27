# Worktree-location commands exceed deadlines in the aggregate

- **ID:** 1107
- **Status:** open
- **Date observed:** 2026-10-27
- **File:** `apps/backend/src/core/commands-environment-worktree-location.test.ts` (unchanged).
- **Tests:** `start uses and persists both explicit and configured roots; generic reads stay within the worktree`; `retargeting an accepted alias keeps creation and cleanup at the original physical root`.
- **Original command:** `mise run test:logged -- --name review-full -- mise run test`, on the 0247 review follow-up; macOS arm64, Bun 1.4.4, two backend workers and other test groups/worktrees active.
- **Failure:** deadlines reported at 13830.93 ms and 5541.76 ms; the first case reports a beforeEach/afterEach hook timeout and Bun reports four dangling processes.
- **Evidence:** `orkestrator-test-run.TZNWYO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Owner rerun:** `mise run test:logged -- --name worktree-location-owner -- bun test --cwd apps/backend ./src/core/commands-environment-worktree-location.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0, 7.5 s.
- **Hypothesis:** shared-host scheduling delays during Git-heavy fixture setup and reconciliation. Not established. No test assertion, deadline, skip or production implementation was changed.
