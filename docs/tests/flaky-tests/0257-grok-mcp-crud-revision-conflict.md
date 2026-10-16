# Grok MCP CRUD revision conflict in the aggregate suite

- **ID:** 0257
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `Grok adapter > Grok: native TOML CRUD, compatibility sources read-only and below native`
- **Owning file:** `apps/backend/src/core/mcp-management/service-grok.test.ts:37`
- **Original command:** `mise run test:logged -- --name non-ios -- mise run test`.
- **Worker configuration:** aggregate workspace/root/bridge/protocol reservations
  of 4/1/2/1 slots, with two isolated backend workers; component browser
  validation also ran during part of the aggregate.
- **Failure:** `McpManagementFailure: McpManagementError:revision-conflict: The
  configuration changed since it was loaded. Reload and try again.` (34.67 ms).
- **Suite counts:** backend had 8,282 passed, 40 skipped, four failed and one
  between-tests error across 8,326 tests. The other failures were outside MCP.
- **Isolated rerun:** `mise run test:logged -- --name grok-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/mcp-management/service-grok.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file, exit 0, in 0.3 s.
- **Evidence:** `orkestrator-test-run.6257an/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the aggregate hit a revision conflict during the CRUD flow;
  the isolated pass establishes intermittency, but the conflict's cause remains
  unconfirmed. The unread-toast changes do not alter MCP management.
