# Merged running-container cleanup times out deleting the remote head branch

- **ID:** 0786
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `Electron backend environment lifecycle commands > deletes the remote head branch during merged running container cleanup`
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`
- **Original command:** `env -u PORT mise run test:logged -- --name full-test-3 -- mise run test (todo-0050 branch rebased on main at a5d78cfc)`
- **Worker configuration:** the default aggregate runner on node mbp3 (Mac17,6, 18 cores), with other workspaces keeping the host at load average 17 to 38.
- **Failure:** Bun's five-second generic budget at 5003.45 ms. The aggregate took 1255.1 s; the same run hit the known firewall and OpenCode-version failures.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/commands-registry-environments.test.ts` passed the unchanged owner (68 of 68, 31.4 s).
- **Hypothesis:** the case drives real Git and fake-Docker shims inside the generic budget, like the resolved fixture-shim cases 0130 and 0194; aggregate host load can exceed it. The branch does not touch environment deletion or its fixtures. No assertion, timeout or skip changed.
