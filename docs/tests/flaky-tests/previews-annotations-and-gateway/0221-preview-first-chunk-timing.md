# Preview first HTML chunk timing

- **ID:** 0221
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test/file:** `forwardPreviewRequest and forwardPreviewUpgrade > streams the first HTML chunk before the upstream completes`, `packages/protocol/src/node/preview-forward.test.ts:310`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; protocol package tests used two isolated Bun workers. Other host capacity was occupied when the aggregate started.
- **Failure:** `expect(result.firstChunkAt).toBeLessThan(140)` received `145`; case duration 278.89ms.
- **Suite counts:** protocol package: 1,457 passed, 1 failed across 90 files (8.33 seconds). Root/support: 2,956 passed, 1 skipped, 6 failed across 135 files (214.13 seconds). Bridges and protocol lockfile groups passed.
- **Evidence:** `/tmp/orkestrator-test-run.l8GUXI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and adjacent `summary.json`.
- **Isolated rerun:** with the testing guide's GNU-tool PATH, `mise run test:logged -- --name protocol-owner -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/node/preview-forward.test.ts --parallel=1 --only-failures` passed unchanged (28 tests, exit 0, 0.5 seconds).
- **Diagnostic limitation:** an earlier root-directory invocation loaded the root DOM preload and failed two WebSocket cases; that invocation does not reproduce the protocol package's test environment. The owning-package rerun above uses its Node-only preload.
- **Hypothesis:** scheduler or host load delayed delivery across the strict 140ms threshold. The inheritance-guard change does not alter preview forwarding. Root cause remains unconfirmed; no assertion, timeout or skip was changed.

## Resolution (2026-10-17)

The case asserted a wall-clock race: it released the upstream after a 150 ms
sleep and required the first chunk before 140 ms. A scheduling delay of more
than 140 ms anywhere on the path failed it, although streaming was correct.
The property is ordering, so the test now releases the upstream from the
client's first `data` event and checks that this chunk holds `first` and not
`second`. A forwarder that buffered the body until the upstream ended would
never deliver that chunk, and the test would time out.

- `bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/node/preview-forward.test.ts -t "streams the first HTML chunk" --rerun-each 200`,
  at a load average of about 20: 200 of 200 passed. The owning file passed
  alone (30 tests).
