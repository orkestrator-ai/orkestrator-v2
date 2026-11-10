# MCP removal preview reports a revision conflict in the aggregate

- **ID:** 0217
- **Status:** resolved
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
