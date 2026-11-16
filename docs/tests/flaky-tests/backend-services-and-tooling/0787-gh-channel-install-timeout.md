# gh channel install times out in the aggregate

- **ID:** 0787
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `gh channel > installs the newest gh after checking GitHub's checksum and uses it`
- **File:** `apps/backend/src/core/host-maintenance-tasks.test.ts`
- **Original command:** `env -u PORT mise run test:logged -- --name full-test-3 -- mise run test (todo-0050 branch rebased on main at a5d78cfc)`
- **Worker configuration:** the default aggregate runner on node mbp3 (Mac17,6, 18 cores), with other workspaces keeping the host at load average 17 to 38.
- **Failure:** Bun's five-second generic budget at 5035.35 ms.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/host-maintenance-tasks.test.ts` passed the unchanged owner (13 of 13, 0.6 s).
- **Hypothesis:** the fixture's archive extraction and checksum work runs in subprocesses that aggregate load can slow past the generic budget. The branch does not touch host maintenance. No assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation at load 17 to 38. The owner passed alone today (13/13, 0.56 s), so reaching five seconds means the case's subprocesses stalled for seconds.
- **Next step:** give the case an explicit budget like the other subprocess fixtures; if it does not recur by the next sweep, reclassify it as environmental.

## Resolution (2026-11-15)

- **Root cause:** archive extraction and checksum subprocesses were starved past Bun's 5 s default budget.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup.ts`, `tests/setup-node.ts`), raises Bun's default per-test and hook budget from 5 s to 60 s (a hang watchdog only). `apps/backend/src/core/host-maintenance-tasks.test.ts` sets no smaller budget; its `until` helper's 10 s deadline is now a 50 s hang watchdog on the service settling the task.
- **Reproduced:** no — the 5 s default budget was not exhausted before the change under the contention runner; the post-change run below shows only the current state. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f3-a-batch2 -- bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts ./src/core/host-maintenance-tasks.test.ts ./src/core/fix-path.test.ts ./src/core/github-project-credentials.integration.test.ts --rerun-each=3` passed.
