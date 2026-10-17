# Environment move submodule rollback aggregate timeout

- **ID:** 0291
- **Status:** open
- **Date observed:** 2026-10-17

## Codex catalogue review validation — 2026-10-17

- **Test:** `move_environment > a failed submodule re-link restores the original
  checkout`, `apps/backend/src/core/environment-move.test.ts`.
- **Original command:** `mise run test:logged -- --name final-full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, with two isolated backend workers; other worktrees shared the host).
- **Failure:** the case exceeded its 5000 ms deadline at 5079.69 ms. This is a
  timeout, distinct from the resolved fixture index-lock failure in case 0201.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  (compressed when the aggregate completes).
- **Owning-file rerun:** `mise run test:logged -- --name move-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 47.3 seconds.
- **Assessment:** the isolated pass confirms intermittence. Shared-host Git and
  filesystem contention remains a hypothesis; no move implementation,
  assertion, timeout or skip changed.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.

## Codex default-model PR-stage main merge — 2026-10-17

- **Original command:** `bun run --cwd apps/backend test:workspace` (Bun 1.4.2, two workers; host load average 13–27).
- **Failure:** the case exceeded its 5000 ms deadline at 5121.09 ms.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts` passed unchanged (37 passed, 31.6 seconds).
- **Assessment:** a second isolated pass; no move implementation, assertion, timeout or skip changed.
