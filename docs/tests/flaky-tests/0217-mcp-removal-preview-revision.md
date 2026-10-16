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

## Recurrence on 2026-10-16

`mise run test` on the OpenCode skew-guard branch (base `9906db30`, no
backend source changed) failed this case and two sibling MCP cases with the
same "The configuration changed since it was loaded" revision conflict:

- `rename through the service > a rename preview warns about a Claude project
  approval naming the old server` (`service-rename.test.ts`, 15.00 ms);
- `project-scope CRUD > claude: the private local map is edited inside
  ~/.claude.json only` (`service-sources.test.ts`, 6.41 ms);
- this case (`service.test.ts`, 4.37 ms).

Backend counts: 8,084 passed, 40 skipped, 4 failed. The fourth failure was
`agent provider module boundaries > keeps every provider implementation module
within 1,500 lines`, which is deterministic on `main` (`http-bridge-provider.ts`
has 1,505 lines since #1016) and not a flake. Other machine environments were
running suites at the same time. Each MCP owning file passed alone with
`bun test --cwd apps/backend <file>`: `service.test.ts` 23 passed,
`service-rename.test.ts` 2 passed, `service-sources.test.ts` 13 passed.
Evidence: `/tmp/orkestrator-test-run.0CVlWk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
