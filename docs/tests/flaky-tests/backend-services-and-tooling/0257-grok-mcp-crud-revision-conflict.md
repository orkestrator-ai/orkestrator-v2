# Grok MCP CRUD revision conflict in the aggregate suite

- **ID:** 0257
- **Status:** resolved
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
  fresh stores. This case recorded no base commit; it was observed on
  2026-10-16 on the unread-notification branch (#1033), the day `8ecbc854e`
  merged, and its siblings 0217 and 0250 recorded base `9906db30`, which
  predates the fix. That this observation lacked the fix is inferred from
  the date and the reproduction below, not proven. No further change.
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
