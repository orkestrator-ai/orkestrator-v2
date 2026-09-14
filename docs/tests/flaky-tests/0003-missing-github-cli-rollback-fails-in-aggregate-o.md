# Missing-GitHub-CLI rollback fails in aggregate only (2026-09-10)

- **ID:** 0003
- **Status:** open
- **Original command:** `mise run test`, using the default eight-worker plan
  (four root workers, two bridge tasks, and two one-worker workspace tasks).
- **Test:** `create_project_from_scratch > rolls back when GitHub CLI is
  definitely missing`, in
  `apps/backend/src/core/commands-project-creation.test.ts`.
- **Failure:** the project-path access promise resolved where the test expected
  it to reject, after the mocked missing `gh` executable should have triggered
  rollback (28.04 ms).
- **Suite counts:** backend 2,966 total; 2,958 passed, 8 failed, 5 errors. The
  other failures came from the validation subprocess cluster and were traced to
  an incompatible diagnostic `--no-orphans` experiment that was removed.
- **Isolated rerun:** `mise exec -- bun test --cwd apps/backend
  ./src/core/commands-project-creation.test.ts --parallel=1 --only-failures` →
  39 passed, 0 failed in 981 ms.
- **Hypothesis:** another aggregate owner races the temporary project path or
  its mocked command environment. The isolated pass establishes a credible
  flake but does not yet identify that owner.
- **Recurrence:** after merging `origin/main` on 2026-09-10,
  `mise run test:changed` reproduced the same resolved-path assertion in
  27.75 ms. The backend group reported 2,986 passed, 1 skipped, and 1 failed
  across 134 files. The logged isolated rerun
  `mise run test:logged -- --name project-creation-isolated -- bun test --cwd
  apps/backend --preload ../../tests/setup-node.ts
  ./src/core/commands-project-creation.test.ts --parallel=1 --only-failures`
  passed in 1.0 seconds.
