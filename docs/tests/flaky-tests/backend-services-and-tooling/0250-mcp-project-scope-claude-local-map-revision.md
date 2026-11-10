# Claude project-scope MCP edit rejected with a revision conflict

- **ID:** 0250
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Root cause:** a product race in `McpSourceStore.secretKey()`
  (`apps/backend/src/core/mcp-management/source-store.ts`). Every revision is
  an HMAC under a per-backend key created on first use, and the first use is
  the catalog load, which reads every source file at once
  (`Promise.all` in `catalog.ts`). Before `8ecbc854e`, concurrent first calls
  each loaded the key on their own: one created the key file with `wx` while
  another found it empty or short, failed its own `wx` with `EEXIST` and read
  it back before the bytes were written. The calls ended with different keys
  and `this.key` kept whichever assigned last, so the snapshot's revision and
  the revision re-read by the next `validate`/`mutate` were computed under
  different keys and the write was refused as `revision-conflict`. Load
  widened the create-to-write window. Case 0222 is the same race seen as
  `request-conflict`.
- **Fix:** already on `main`: `8ecbc854e` (#1025, merged 2026-10-16) makes
  concurrent callers share one in-flight key load (`keyLoad`), and
  `source-store.test.ts` (`concurrent first uses agree on one key`) races 50
  fresh stores. Every observation of this case ran on a base without it
  (`9906db30` predates `8ecbc854e`). No further change.
- **Reproduced:** yes — with the shared load temporarily removed and a 5 ms
  sleep injected between creating the key file and writing it, `bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/mcp-management/service.test.ts
  ./src/core/mcp-management/service-sources.test.ts
  ./src/core/mcp-management/service-grok.test.ts --parallel=1` failed
  `removal preview names the entry that becomes effective` and `Grok: native
  TOML CRUD, compatibility sources read-only and below native` with the
  recorded revision conflict, and `-t "private local map" --rerun-each=10` on
  `service-sources.test.ts` failed 4 of 10 the same way. With the shared load
  restored and the same 5 ms sleep still injected, both commands passed
  (`repro-mcp-key-fixed`, `fixed-mcp-0250`). The injected edits were reverted.
- **Stress:** `mise run test:logged -- --name stress-mcp -- bun
  scripts/test-under-contention.ts -- bash -c 'cd apps/backend && for i in
  $(seq 10); do bun test --preload ../../tests/setup-node.ts
  ./src/core/mcp-management/service.test.ts
  ./src/core/mcp-management/service-sources.test.ts
  ./src/core/mcp-management/service-grok.test.ts
  ./src/core/mcp-management/source-store.test.ts --parallel=4 || exit 1;
  done'` passed 10 of 10 fresh runs (macOS, unpinned burners, host load ~35).
