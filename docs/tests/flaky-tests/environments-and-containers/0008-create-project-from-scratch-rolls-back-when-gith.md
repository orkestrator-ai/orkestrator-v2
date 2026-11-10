# `create_project_from_scratch > rolls back when GitHub CLI is definitely missing` (`apps/backend/src/core/commands-project-creation.test.ts:292`)

- **ID:** 0008
- **Status:** resolved
- **Date observed:** 2026-09-03; recurred 2026-09-08
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the workspace group ran six Turbo packages, and the backend package used two
  Bun workers.
- **Failure:** after project creation correctly rejected with the missing-GitHub-
  CLI error, `expect(fs.access(projectPath)).rejects.toThrow()` received a
  resolved promise because the temporary project directory was still present
  (reported duration: 30.21 ms).
- **Suite counts:** backend package — 2,414 total, 2,413 passed, 1 failed, and
  8,931 assertions across 100 files in 49.45 s.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts
  src/core/commands-project-creation.test.ts --only-failures` from
  `apps/backend` -> 39 passed, 0 failed, and 107 assertions in 1.44 s.
- **2026-09-08 recurrence:** `mise exec -- bun run test` under Bun 1.4.2
  produced the same resolved-`fs.access` assertion in the four-group
  concurrent suite (27.76 ms). The backend package reported 2,797 passed and
  one failed across 120 files in 99.33 s. Rerunning the owning file alone with
  `mise exec -- bun test --preload ../../tests/setup-node.ts
  ./src/core/commands-project-creation.test.ts` from `apps/backend` passed all
  39 tests and 107 assertions in 1.30 s without a source change.
- **2026-09-10 recurrence:** `mise run test` failed the same assertion twice in
  consecutive eight-worker aggregate runs (30.61 ms and 29.46 ms); the exact
  owner rerun passed in 30.92 ms. A bounded diagnostic on the second aggregate
  recurrence found the retained project directory contained exactly `.git`,
  so rollback had not removed any Git metadata. Evidence:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.omW1xF/summary.json`
  and
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.EAbIpI/summary.json`.
- **Hypothesis:** `createProjectFromScratch` awaits its best-effort rollback
  before rejecting, but the rollback deliberately swallows failures and first
  abandons deletion if the directory identity changed. The new evidence rules
  out an empty directory that merely missed `rmdir`, but still does not
  distinguish an identity-guard refusal from an exception before or during
  `.git` removal. A recurrence should capture that internal outcome before
  changing the safety guard or production rollback behavior.

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
