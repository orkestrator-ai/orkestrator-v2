# Missing-GitHub-CLI rollback fails in aggregate only (2026-09-10)

- **ID:** 0003
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Root cause:** a product race between the scratch repository's first
  commit and the failed creation's rollback. `createProjectFromScratch` and
  `initLocalProject` (`apps/backend/src/core/commands-projects.ts`) run
  `git commit --allow-empty`; current Git (2.56 on this host) then starts
  `git maintenance run --auto --quiet --detach` (seen in a `GIT_TRACE2_EVENT`
  trace), which daemonizes and keeps touching `.git` after `git commit` has
  exited. When the creation then fails before any remote exists (the missing
  `gh` executable in 0003/0008, the missing PAT in 0690),
  `rollbackScratchRepository` removes `.git` and `rmdir`s the folder. If the
  detached maintenance child writes into `.git` during or after that
  removal, `.git` survives, the `rmdir` refuses the non-empty folder, and the
  best-effort rollback swallows it: exactly the retained folder holding only
  `.git` recorded on 2026-09-10. A user whose creation failed the same way
  could be left with that folder.
- **Fix:** the scratch commit is built by one helper, `scratchCommitArgs`,
  which adds `-c maintenance.auto=false` to that single command, so no
  detached child outlives it. The project's later Git use keeps auto
  maintenance. The argv expectation in
  `apps/backend/src/core/commands-project-creation.test.ts` gains the two
  arguments; no other assertion changed.
- **Reproduced:** yes — a probe (`/tmp` script, not committed) that ran
  `git init` + `git commit --allow-empty` and then the same `fs.rm(.git)` +
  `rmdir` left the folder behind in 6 of 150 runs, and in 0 of 150 with
  `-c maintenance.auto=false`. The unchanged owners failed under
  `mise run test:logged -- --name repro-0008 -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-project-creation.test.ts ./src/core/github-project-credentials.integration.test.ts -t "definitely missing|missing PAT" --rerun-each=40`:
  7 of 160 (two `rolls back when GitHub CLI is definitely missing`, five
  `missing PAT … not.toContain("scratch")`).
- **Stress:** the same command with the fix (`repro-0008-fixed`) passed 160
  of 160; the complete owners `commands-project-creation.test.ts`,
  `github-project-credentials.integration.test.ts` and
  `git-fsmonitor.test.ts` passed (`owners-0008`).
