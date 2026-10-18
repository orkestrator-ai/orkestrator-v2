# Environment lifecycle Git lock and deletion timeout in the aggregate

- **ID:** 0384
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`
- **Tests:** `Electron backend environment lifecycle commands > creates local worktrees from the fetched remote base branch`; `Electron backend environment lifecycle commands > removes the environment even when remote branch deletion fails for a non-404 reason`.
- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, with the documented Homebrew GNU shell-tool directories preferred on `PATH`.
- **Worker configuration:** Aggregate workspace/root/bridge/protocol reservations of 4/1/2/1 slots; two isolated Bun workers per workspace package. Other worktrees and browser validation were active on the shared macOS host.
- **Failures:** The fetched-base case failed after 3417.00 ms because `git commit -am environment commit` could not create the linked worktree's existing `index.lock` (exit 128). The non-404 deletion case exceeded its five-second deadline (5312.32 ms).
- **Isolated rerun:** `mise run test:logged -- --name merge-environments-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 21.0 seconds logged). A preceding one-worker run including the four account/usage owners also passed.
- **Evidence:** `orkestrator-test-run.IqZNat/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` below the platform temporary directory (compressed as `.log.gz` if the aggregate fails).
- **Hypothesis:** Background Git scans may contend with the fixture commit; shared-host latency may account for the separate deletion deadline. Neither cause is established by the isolated pass. No implementation, assertion, timeout or skip changed.
