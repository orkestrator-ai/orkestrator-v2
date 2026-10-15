# Deletion that cannot reap a server: aggregate timeout (`apps/backend/tests/commands-registry-environments.test.ts`)

- **ID:** 0215
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server`
- **Owning file:** `apps/backend/tests/commands-registry-environments.test.ts:3617`
- **Original command:** `mise run test:logged -- --name full-suite-3 -- mise run test`
  on the default PATH, with the standard group slots. Other workers' suites
  were running on the same host.
- **Failure:** failed at 6,222.99 ms with no assertion message, past Bun's
  five-second default. The last log lines were the expected
  `Stopping codex:env-delete-failure` and `Environment cleanup step worktree failed`.
- **Suite counts:** backend 7,705 passed, 39 skipped, 1 failed (7,745 tests,
  423 files, 330.87 s). The web, root, bridges and protocol groups passed.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1`
  from `apps/backend`: 68 passed in 20.77 s.
- **Evidence:** `/tmp/orkestrator-test-run.AAEzu7/` and `/tmp/orkestrator-test-run.2uhUui/`.
- **Hypothesis:** host contention, as in 0211 and 0214. Not confirmed.
