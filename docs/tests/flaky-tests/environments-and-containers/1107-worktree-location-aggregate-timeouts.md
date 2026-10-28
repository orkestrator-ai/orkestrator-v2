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


## Storage-maintenance review fixes recurrence (2026-10-27)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) timed out in `retargeting an accepted alias keeps creation and cleanup
at the original physical root` after 6686.39 ms against its 5000 ms deadline.
The host load average was subsequently observed at 138.87.

The complete unchanged owner passed alone (9 tests, exit 0, 13.5 s):

```sh
mise run test:logged -- --name worktree-location-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-environment-worktree-location.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory in
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The aggregate remains non-green. Contention is a hypothesis; the owner,
implementation and deadlines were unchanged.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.
