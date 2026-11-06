# Real `::` listener test loses its free port to another process (apps/backend/src/core/preview-listener-ownership.test.ts)

- **ID:** 1410
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `LoopbackListenerOwnership on this host > attributes a real :: listener and refuses another environment` (`apps/backend/src/core/preview-listener-ownership.test.ts:358`)
- **Original command:** `mise run test` on macOS during todo 0996, with other workers running on the same host.
- **Worker configuration:** Bun 1.4.4; backend workspace group with the default `--parallel` workers.
- **Failure:** the spawned listener exited with `listen EADDRINUSE: address already in use :::63377`, so the test failed with `listener exited 1` at line 373 (duration: 16.99 ms).
- **Suite counts:** the backend workspace group had 2 failures. The other was `the pinned Codex parser accepts the production argument shape and secured catalog`, because this new worktree had no `binaries/codex`; it passed once `mise run download:codex` had run, and is not a flake.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/preview-listener-ownership.test.ts --parallel=1` from `apps/backend` → passed (19 pass) three times in a row.
- **Hypothesis:** `freePort()` binds port 0 on `127.0.0.1`, closes it, and only then does a separate process bind `::` on that port. Another process can take the port in that gap, and a listener on an address other than `127.0.0.1` can already hold it, because the probe only checks one address. Which process held 63377 was not captured. The test does not reach the todo 0996 code, but the same file was not run in a full aggregate on the base commit, so that branch is not formally excluded.

### Resolution — 2026-11-06

**Root cause.** The recorded time-of-check race: `freePort()` probed a port on
`127.0.0.1` and released it, and only later did the spawned shell's server
bind that number on `127.0.0.1` or `::`. Another worker could take the port in
the gap, and for `::` the probe never checked the address being bound.

**Fix.** `apps/backend/src/core/preview-listener-ownership.test.ts`: the
spawned server listens on port 0 on its own address and prints the port it
got, which the test reads (as the sibling LAN-interface test already did). The
connect-through-`127.0.0.1` proof and every attribution assertion are
unchanged. The final `none` check still probes a fresh port; it can only
misattribute if another process binds it in that instant, and has no recorded
failure.

**Not reproduced** (the gap no longer exists).

**Verification.** `NODE_ENV=test mise run test:logged -- --name plo-fix-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-listener-ownership.test.ts --rerun-each=10`: PASS.
