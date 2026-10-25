# copying a project to another machine > suggested files are ticked, dependencies hidden, and the copy names target, location and files

- **ID:** 0783
- **Status:** open
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
