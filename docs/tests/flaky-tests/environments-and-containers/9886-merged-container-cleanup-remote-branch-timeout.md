# Merged running-container cleanup times out deleting the remote head branch

- **ID:** 9886
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `Electron backend environment lifecycle commands > deletes the remote head branch during merged running container cleanup`
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`
- **Original command:** `env -u PORT mise run test:logged -- --name full-test-3 -- mise run test (todo-0050 branch rebased on main at a5d78cfc)`
- **Worker configuration:** the default aggregate runner on node mbp3 (Mac17,6, 18 cores), with other workspaces keeping the host at load average 17 to 38.
- **Failure:** Bun's five-second generic budget at 5003.45 ms. The aggregate took 1255.1 s; the same run hit the known firewall and OpenCode-version failures.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/commands-registry-environments.test.ts` passed the unchanged owner (68 of 68, 31.4 s).
- **Hypothesis:** the case drives real Git and fake-Docker shims inside the generic budget, like the resolved fixture-shim cases 0130 and 0194; aggregate host load can exceed it. The branch does not touch environment deletion or its fixtures. No assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. The case uses Bun's default five seconds, while the same file already applies `ASYNC_TEST_BUDGET_MS` to its other real-shim cases (the fix pattern from [0130](0130-electron-command-registry-fixture-shim-timeouts.md)).
- **Next step:** give the case the same explicit budget.

## Resolution (2026-11-15)

- **Root cause:** Merged running-container cleanup runs fake Docker and Git; it exceeded Bun's 5 s default at high host load.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The file's default is 60 s (equal to the preload).
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
