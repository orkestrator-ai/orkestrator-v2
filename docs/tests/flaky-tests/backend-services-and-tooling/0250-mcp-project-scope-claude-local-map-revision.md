# Claude project-scope MCP edit rejected with a revision conflict

- **ID:** 0250
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `project-scope CRUD > claude: the private local map is edited inside ~/.claude.json only`
- **Owning file:** `apps/backend/src/core/mcp-management/service-sources.test.ts:66`
- **Original command:** `mise run test` on `multi-review-flow-graph-followups`
  (Multi Review flow graph follow-ups: zoom, step transcript tails, queue
  position, provisional findings; no MCP management code changed). Other
  worktrees were working on the host.
- **Failure:** the edit rejected with `McpManagementError:revision-conflict`
  ("The configuration changed since it was loaded. Reload and try again."),
  thrown from `mcp-management/service.ts:402` through `source-store.ts:335`,
  after 6.43 ms.
- **Suite counts:** backend 8,126 passed, 40 skipped, 3 failed across 442
  files (319 s). The other failures were case 0180 and
  `agent provider module boundaries` (deterministic: `http-bridge-provider.ts`
  is 1,505 lines on `main` at `9906db30`, over its 1,500-line limit).
- **Isolated owning-file rerun:** `bun test src/core/mcp-management/service-sources.test.ts`
  from `apps/backend` passed (13 pass, 0 fail).
- **Evidence:** `/tmp/orkestrator-test-run.zlamOL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** same family as 0217 and 0222 (revision conflicts in MCP
  management writes under aggregate load); not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
