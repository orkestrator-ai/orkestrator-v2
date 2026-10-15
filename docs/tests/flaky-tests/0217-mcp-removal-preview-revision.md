# MCP removal preview reports a revision conflict in the aggregate

- **ID:** 0217
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `McpManagementService — writes > removal preview names the entry that becomes effective`
- **Owning file:** `apps/backend/src/core/mcp-management/service.test.ts`
- **Original command:** the testing guide's macOS GNU-tool PATH with
  `mise run test:logged -- --name final-merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; the workspace group waited 210.5 seconds for host capacity.
- **Failure:** the removal preview rejected with "The configuration changed
  since it was loaded. Reload and try again." at `service.test.ts:649`,
  through `service.ts:354` and `mcp-management.ts:723` (4.01 ms).
- **Backend counts:** 7742 passed, 39 skipped, 2 failed across 425 files in
  287.87 seconds. The other failure was the previously documented shutdown
  deadline test, which also failed alone. Root, bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name final-mcp-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/mcp-management/service.test.ts
  --parallel=1 --only-failures` passed unchanged in 1.2 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.kN0jZS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer summary `/tmp/orkestrator-test-run.H3aPI5/summary.json`.

The cause remains unconfirmed. The merge resolutions only changed
documentation; no assertion, timeout or skip was changed.
