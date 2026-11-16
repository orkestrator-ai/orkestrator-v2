# `MobileAppShellLayout` drawer focus-restoration timeouts (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **ID:** 0068
- **Status:** resolved
  package execution is not governed by the aggregate worker cap
- **Date observed:** 2026-08-14
- **Affected tests:** `closes the project drawer from its backdrop and restores trigger focus` (5,811.44 ms in the first run, 6,830.57 ms in the second) and `closes the initial project drawer from its close button and restores trigger focus` (16,456.55 ms, second run only).
- **Original command:** `set -o pipefail; bun test --cwd apps/web --parallel 2>&1 | tee /tmp/ork-web-tests.log`, and again into `/tmp/ork-web-tests2.log`.
- **Worker configuration:** the web workspace package ran alone with `--parallel` (18 workers on this machine); no other test group ran concurrently.
- **Failure:** both cases exceeded Bun's 5,000 ms outer budget and reported `this test timed out after 5000ms`. No assertion mismatch was reported in either run.
- **Suite counts:** first run 4,835 passed, 1 skipped, 4 failed across 211 files (the other three were two `ActionBar` cases updated by the review-picker change in the same commit and a separate deterministic `AgentNativeTab` failure). Second run 4,836 passed, 1 skipped, 3 failed across 211 files in 268.51 seconds.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/ork-mobile-shell.log` -> 24 passed, 0 failed in 9.17 seconds.
- **Recurrence 2026-08-15:** `closes the initial project drawer from its close button and restores trigger focus` timed out again at 13,029.58 ms during `set -o pipefail; bun test --cwd apps/web --parallel` (4,845 passed, 1 skipped, 2 failed across 211 files in 193.84 seconds; the other failure was the same unrelated deterministic `AgentNativeTab` case). The backdrop case passed in that run. Isolated rerun of the owning file passed 24/0 in 4.23 seconds. Unrelated test processes from another session were competing for CPU during the aggregate run, which is consistent with the mount-cost hypothesis below.
- **Recurrence 2026-08-29:** `bun run test` timed out `closes the project
  drawer from its backdrop and restores trigger focus` after the aggregate
  runner reported 384,107.52 ms against the case's 20-second budget. The web
  workspace reported 5,577 passed, 1 skipped, 3 failed, and 1 trailing error
  across 5,581 tests. The isolated rerun `bun test
  src/components/layout/MobileAppShellLayout.test.tsx` from `apps/web` passed
  25/25 in 4.38 s; the affected case passed in 1,824.25 ms.
- **Relationship to the entry above:** these are the two cases produced by that entry's split. The split gave each focus transition its own budget, and the initial-open case has not recurred, but the two close-and-restore transitions still time out under a fully parallel web-package run.
- **Hypothesis:** each case still mounts the whole mobile shell before it exercises one Radix focus restoration, so the fixed five-second budget is mostly setup. The dismissal assertions themselves hold in isolation, which points at the shared mount cost under 18-way parallelism rather than at the focus behaviour. A lighter mount, or an explicit per-test budget, should be evaluated before the drawer's focus handling is changed.

## Resolution (2026-11-15)

- **Class:** default budgets (A).
- **Root cause:** each close-and-restore case waits for Radix's focus hand-off with Testing Library's `waitFor` (1 s default) inside Bun's 5 s test default (one case had its own 20 s); under 18-way parallelism the mount plus hand-off exceeded those.
- **Fix:** `tests/default-test-timeout.ts` (a 60 s per-test and hook hang watchdog in both shared preloads, replacing Bun's 5 s default); `apps/web/src/test/async-util-hang-watchdog.ts` (new: `useAsyncUtilHangWatchdog()` sets Testing Library's `asyncUtilTimeout` to a 30 s hang watchdog per test and restores it, as `useAnnotationUiTestBudget` does), called in `apps/web/src/components/layout/MobileAppShellLayout.test.tsx`; the 20 s third argument is removed. The waits still observe focus reaching the trigger.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker.
- **Stress:** `mise run test:logged -- --name web-cont2 -- bun scripts/test-under-contention.ts --core 3 --burners 6 -- bash -c 'cd apps/web && for i in 1 2 3; do NODE_ENV=test bun test src/components/projects/CoordinatorPanel.render-cost.test.tsx || exit 1; done && NODE_ENV=test bun test src/lib/node-scope/multiplexed-relay-stream.test.ts src/components/layout/MobileAppShellLayout.test.tsx src/components/federation/ProjectCopyDialog.test.tsx src/components/graph-designer/GraphDesignerEditing.test.tsx src/components/federation/federation-ui.test.tsx ../../tests/unit/components/FeaturesView.test.tsx --parallel=1'` passed (100.2 s). (`CoordinatorPanel.render-cost.test.tsx` is not `--rerun-each` safe: its `afterAll` restores the real modules, so the second in-process run fails on the unchanged file too; it is looped in fresh processes.)
