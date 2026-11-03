# Incoming node mail placement races automatic injection

- **ID:** 1780
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `CO-05/UP-02 coordinator mail to and from a leaf agent > delivers as ordinary incoming mail and routes the agent's answer to that command node's outbox`
- **Owning file:** `apps/backend/src/core/nodes/node-coordination.test.ts:119`

## Observation

`mise run test:logged -- --name validation-test-index-repaired -- mise run test`
failed after 301.8 s. Workspace had six worker slots, root one, bridges two,
and protocol-lockfile one. This test expected `pending-inject` and received
`injected` at 75.67 ms. Root passed (222.4 s), web passed (11407 pass, zero
fail, 11417 tests), bridges and protocol-lockfile passed. Evidence:
`/tmp/orkestrator-test-run.exaMuO/validation-test-index-repaired.log.gz`
and inner artifact directory `/tmp/orkestrator-test-run.F3tqff`.

## Isolated reruns

`mise run test:logged -- --name node-mail-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures`
passed unchanged on this branch in 1.9 s. The same owner command with log name
`main-node-mail-owner` passed in 1.5 s on independently installed detached
`origin/main` at `d7cdfaa8b`. The temporary worktree was removed.

## Interpretation

The failure is consistent with injection advancing before the assertion, but
no cause or target-branch failure was reproduced. This is a credible flake
because the complete unchanged owner passed alone. It does not excuse the
failed aggregate run. Coordinator workflow retention changes do not touch
this owner or the mail implementation. No unrelated code or test was changed.
