# Deletion that cannot reap a server: aggregate timeout (`apps/backend/tests/commands-registry-environments.test.ts`)

- **ID:** 0226
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

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** the same deletion-reap case exceeded its five-second deadline
  at 5037.65 ms.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-environments -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 20.6 seconds (exit 0).
- **Disposition:** recurrence confirmed by the isolated pass; shared-host
  contention remains a hypothesis. No test, timeout or skip was changed.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `retains the environment and process ownership when deletion cannot reap a server` timed out after 5408.64 ms.
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-lifecycle-isolated -- bun test --cwd apps/backend ./tests/commands-registry-environments.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 40.4 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; the cause remains unconfirmed. No product code, assertion, timeout or skip was changed.
