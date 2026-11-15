# copying a project to another machine > suggested files are ticked, dependencies hidden, and the copy names target, location and files

- **ID:** 0783
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `copying a project to another machine > suggested files are ticked, dependencies hidden, and the copy names target, location and files`
- **Owning file:** `apps/web/src/components/federation/ProjectCopyDialog.test.tsx`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=a5d78cfcd54907a13973463d4bd08497fd025c90 mise run test:logged -- --name merge-tests -- mise run test`, with the GNU shell-tool PATH from the testing guide.
- **Worker configuration:** aggregate workspace group, two package tasks with two Bun workers per package; other worktrees were validating on the same host.
- **Failure:** The case exceeded the five-second outer deadline (5143.15 ms).
- **Suite counts:** web package: 9,347 passed, 10 skipped, 5 failed across 594 files in 1,067.34 s.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.8ZKWYk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-0043-rerun-project-copy -- bun test --cwd apps/web ./src/components/federation/ProjectCopyDialog.test.tsx --parallel=1 --only-failures` passed unchanged (exit 0, 12.1 s).
- **Hypothesis:** timing sensitivity under concurrent host load; the complete unchanged owning file passed with one worker. No root cause has been established. No assertion, deadline, or skip was changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. The case runs under Bun's default five seconds, and the whole file takes 12 s alone. The last change to the owner (bae046ddf, #1211) predates the observation.
- **Next step:** if it recurs, give the case an explicit budget or split it; otherwise reclassify it as environmental at the next sweep.

## Investigation — 2026-11-06

Not fixed, still open. A JUnit-timed run of the unchanged owner alone took
0.23 s for this case. Its sibling,
`a coordinator's copy request is approved from the copy dialog with the user's choices`,
took 3.11 s against the same five-second default (load average about 20), so
that sibling is the likelier next timeout. No race was found in this case.

## Resolution (2026-11-15)

- **Class:** default budget (A).
- **Root cause:** the case ran under Bun's 5 s default; the file takes about 12 s alone, and its waits used Testing Library's 1 s default (two had explicit 5 s timeouts).
- **Fix:** `tests/default-test-timeout.ts` (a 60 s per-test and hook hang watchdog in both shared preloads, replacing Bun's 5 s default); `apps/web/src/test/async-util-hang-watchdog.ts` (new: `useAsyncUtilHangWatchdog()` sets Testing Library's `asyncUtilTimeout` to a 30 s hang watchdog per test and restores it, as `useAnnotationUiTestBudget` does), called in `apps/web/src/components/federation/ProjectCopyDialog.test.tsx`, and the two explicit 5 s `waitFor` timeouts are removed in its favour.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker.
- **Stress:** `mise run test:logged -- --name web-cont2 -- bun scripts/test-under-contention.ts --core 3 --burners 6 -- bash -c 'cd apps/web && for i in 1 2 3; do NODE_ENV=test bun test src/components/projects/CoordinatorPanel.render-cost.test.tsx || exit 1; done && NODE_ENV=test bun test src/lib/node-scope/multiplexed-relay-stream.test.ts src/components/layout/MobileAppShellLayout.test.tsx src/components/federation/ProjectCopyDialog.test.tsx src/components/graph-designer/GraphDesignerEditing.test.tsx src/components/federation/federation-ui.test.tsx ../../tests/unit/components/FeaturesView.test.tsx --parallel=1'` passed (100.2 s). (`CoordinatorPanel.render-cost.test.tsx` is not `--rerun-each` safe: its `afterAll` restores the real modules, so the second in-process run fails on the unchanged file too; it is looped in fresh processes.)
