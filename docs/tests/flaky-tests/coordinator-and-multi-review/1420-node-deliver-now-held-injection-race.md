# A held node coordinator request reads pending-inject after the turn ends

- **ID:** 1420
- **Status:** open
- **Owner:** `apps/backend/src/core/nodes/node-coordination.test.ts`

On 2026-10-31, while validating
[0940](../../../todo/cross-cutting/0940-failed-turn-reads-as-completed.md) task 3,
`mise run test` failed `a command node's deliverNow on this leaf > node
coordinator requests stay pending while held, until injection` in 182.66 ms. Line
348 expected the message's placement to be `injected` straight after
`world.finishTurn(recipient)` and received `pending-inject`. The backend group
reported 11,711 passed and two failures across 804 files (11,816 tests, 151.34 s),
on a host running other workers. The other failure was the pinned Codex CLI
missing from the fresh worktree, which is unrelated.

The complete owning file then passed alone five times out of five (24 passed):

```sh
mise exec -- bun test src/core/nodes/node-coordination.test.ts
```

run from `apps/backend`. The next full `mise run test` passed this test too. The
change under validation touched no mail or node code, and no assertion, timeout or
skip changed.

The cause is unconfirmed. The hypothesis is that injection after a turn's end
settles a little later than `finishTurn` returns, so a loaded host can read the
placement first. [1324](../aggregate-validation-runs/1324-storage-test-split-0930-validation.md)
records the same kind of placement mismatch for a different test in this file,
under similar load.
