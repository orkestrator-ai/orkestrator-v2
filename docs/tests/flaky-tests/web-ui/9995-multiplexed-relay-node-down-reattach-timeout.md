# Multiplexed relay: one node's re-attach wait times out under load

- **ID:** 9995
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e`.
- **Observed head:** `dev-test-checks-415ac044ae03-r1` at `0178a2e78`. The
  branch changes docs, `scripts/`, `tests/unit/`, `mise.toml` and a workflow;
  nothing under `apps/`, `packages/` or `bridges/`.
- **File:** `apps/web/src/lib/node-scope/multiplexed-relay-stream.test.ts:342`
- **Test:** `multiplexed relay streams > one node down: only its transport sees the outage, and it re-attaches without a reopen`
- **Failure:** `timed out waiting for A back` from the file's `waitFor` helper
  (line 119) after 1,060 ms. The earlier waits (both connected, A
  disconnected) passed.
- **Original command:** `mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  (default suite, web package at its default worker count) on Linux x86_64,
  with other worktrees' runs holding the host's test capacity (16/16 slots
  reserved during the automatic rerun).
- **Suite counts:** web 14,720 passed and 2 failed (this case and
  [StaticHtmlArtifactView flake 9996](../design-canvas-and-artifacts/9996-static-html-read-failure-search-withheld.md)); backend 18,151, desktop 2,149, protocol 5,835,
  toolchain 135, CLI 526 and web-public 52 passed; root, bridge and codex
  protocol lockfile groups passed.
- **Isolated rerun:** the aggregate runner's own rerun was not reached ("the
  600.0s rerun budget is spent"). Rerun by hand, unchanged:
  `mise run test:logged -- --name alone-relay -- bun --no-env-file scripts/bun-test-tier.ts apps/web src/lib/node-scope/multiplexed-relay-stream.test.ts -- --only-failures`
  with `NODE_ENV` unset, as the aggregate runner does: passed (0.6 s).
- **Evidence:** `orkestrator-test-run.BWoW10/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Hypothesis

Unconfirmed. `waitFor` polls 400 times with a 2 ms `setTimeout`, so its
budget is about 0.8 s of timer turns. A loaded host can stretch those turns
until the frames pushed for A's return have not all been handled when the
loop gives up. Reproduce it first (for example under
`scripts/test-under-contention.ts`) before changing the test, and check
whether a slow host could leave the product's re-attach path in the same
state before treating this as a short budget.
