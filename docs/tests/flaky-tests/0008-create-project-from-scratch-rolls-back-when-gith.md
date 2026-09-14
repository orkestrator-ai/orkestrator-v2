# `create_project_from_scratch > rolls back when GitHub CLI is definitely missing` (`apps/backend/src/core/commands-project-creation.test.ts:292`)

- **ID:** 0008
- **Status:** open
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
