# Real `::` listener test loses its free port to another process (apps/backend/src/core/preview-listener-ownership.test.ts)

- **ID:** 1410
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `LoopbackListenerOwnership on this host > attributes a real :: listener and refuses another environment` (`apps/backend/src/core/preview-listener-ownership.test.ts:358`)
- **Original command:** `mise run test` on macOS during todo 0996, with other workers running on the same host.
- **Worker configuration:** Bun 1.4.4; backend workspace group with the default `--parallel` workers.
- **Failure:** the spawned listener exited with `listen EADDRINUSE: address already in use :::63377`, so the test failed with `listener exited 1` at line 373 (duration: 16.99 ms).
- **Suite counts:** the backend workspace group had 2 failures. The other was `the pinned Codex parser accepts the production argument shape and secured catalog`, because this new worktree had no `binaries/codex`; it passed once `mise run download:codex` had run, and is not a flake.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/preview-listener-ownership.test.ts --parallel=1` from `apps/backend` → passed (19 pass) three times in a row.
- **Hypothesis:** `freePort()` binds port 0 on `127.0.0.1`, closes it, and only then does a separate process bind `::` on that port. Another process can take the port in that gap, and a listener on an address other than `127.0.0.1` can already hold it, because the probe only checks one address. Which process held 63377 was not captured. The test does not reach the todo 0996 code, but the same file was not run in a full aggregate on the base commit, so that branch is not formally excluded.
