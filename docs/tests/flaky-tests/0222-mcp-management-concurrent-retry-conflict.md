# Concurrent MCP retries report a request conflict

- **ID:** 0222
- **Status:** open
- **Observed:** 2026-10-15
- **Test:** `McpManagementService — writes > simultaneous retries share the one saved operation`
- **Owner:** `apps/backend/src/core/mcp-management/service.test.ts`

The OpenCode model-selection validation aggregate rejected a concurrent retry
with `request-conflict` after 9.16 ms. The MCP implementation and its owning
test were unchanged. The unchanged owning file passed alone in 1.2 seconds:

```bash
mise run test:logged -- --name mcp-management-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/mcp-management/service.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The cause is not established; no assertions or production behavior were changed.

Recurred on 2026-10-15 in `mise run test` for the sign-in readiness change
(bridges, backend provider and renderer; no MCP code touched): the same
`request-conflict` after 4.74 ms, 1 failure in the backend workspace group,
every other group passing. The unchanged owning file then passed alone three
times in a row (23 pass each):

```bash
bun test src/core/mcp-management/service.test.ts --preload ../../tests/setup-node.ts --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.wdZIQN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
