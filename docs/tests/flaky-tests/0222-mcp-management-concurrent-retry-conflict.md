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

## Recurrence during Claude interaction validation

On 2026-10-15, `mise run test:logged -- --name root-tests -- mise run test`
failed the same unchanged case with `request-conflict` after 7.98 ms. The
backend group reported 8022 passed, 39 skipped and one failed; root, bridge and
protocol-lockfile groups passed. The owning file passed alone in 0.1 seconds:

```bash
mise run test:logged -- --name mcp-service-rerun -- bun test --cwd apps/backend ./src/core/mcp-management/service.test.ts --parallel=1 --preload ../../tests/setup-node.ts
```

Evidence: `/tmp/orkestrator-test-run.y8jiqm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The Claude changes do not touch MCP operation admission; no test was weakened
or skipped.
