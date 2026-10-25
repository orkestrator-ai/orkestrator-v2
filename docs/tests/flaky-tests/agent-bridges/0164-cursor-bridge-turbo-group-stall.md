# Cursor bridge stall in the full-suite bridges group

- **ID:** 0164
- **Status:** open
- **Date observed:** 2026-09-24
- **Tests:** no case reported; Turborepo force-killed `cursor-bridge#test:bridge`
- **Files:** `bridges/cursor-bridge` (package test task)
- **Original command:** `mise run test` on branch
  `20260924-133604-380b3ff31967` (design-space implementation; no bridge code
  changed)
- **Worker configuration:** bridges group concurrent with the root and
  workspace groups; the other four bridge packages finished (codex-bridge
  1,834 pass, 0 fail).
- **Failure:** `[orkestrator-test-runner] No output for 300000ms; terminating
  the group process tree` followed by `Force killed Turborepo tasks:
  cursor-bridge#test:bridge`. The root, workspace and codex-protocol groups
  passed in the same run.
- **Isolated rerun:**
  `mise run test:logged -- --name cursor-bridge -- bun test bridges/cursor-bridge --parallel=2 --only-failures`
  passed in 13.0 s, and
  `mise run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`
  passed in 77.5 s. Two earlier full runs on the same branch passed the
  bridges group.

## Current assessment

Only the Turborepo-driven cursor-bridge task stalled, without output, while
the group ran alongside the other suites; direct runs of the package and of the
whole bridge tree pass. Host contention during the concurrent full suite is the
likely cause. Related: 0158 (cursor bridge config process exit). Keep open
until a recurrence identifies the stalled test.
