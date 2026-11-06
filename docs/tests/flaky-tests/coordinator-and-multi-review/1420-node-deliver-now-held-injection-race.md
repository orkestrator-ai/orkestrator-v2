# A held node coordinator request reads pending-inject after the turn ends

- **ID:** 1420
- **Status:** resolved
- **Owner:** `apps/backend/src/core/nodes/node-coordination.test.ts`

On 2026-10-31, while validating
0940 task 3,
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


### Resolution — 2026-11-06

- **Stale; fixed by `b965aea44` (#1547, merged 2026-11-01 12:34 UTC).** In the
  `held` variant the test sent "Uses the first wake budget." to a busy recipient
  and left that message pending, with its busy backoff, when it released the
  second message. The next `finishTurn` drain could then deliver the first
  message ahead of the released one. That delivery consumed the turn, so the
  released message stayed `pending-inject` with `userReleasedAt` set at
  revision 2, which is exactly the recorded symptom. `b965aea44` settles the
  first delivery (`await world.finishTurn(recipient)`) before sending and
  releasing the second.
- **Every recorded sighting predates that fix.** The 2026-10-31 runs predate it,
  and the 2026-11-01 run on `visual-change-image-05b2937be199-r1` came from
  `ec08062d8` (#1521, merged 11:21 UTC), which does not contain `b965aea44`. No
  recurrence has been recorded since.
- **Reproduced:** yes, for the pre-fix test. With the settle line temporarily
  removed,
  `mise run test:logged -- --name coord-node-prefix -- bun --cwd=apps/backend test ./src/core/nodes/node-coordination.test.ts -t "stay pending while held" --rerun-each=30`
  failed 1 of 30 on an unpinned host (70.8 ms), with the identical
  `pending-inject` / `userReleasedAt` / revision 2 record.
- **Verification of the current test:** `coord-node-postfix` (`--rerun-each=300`):
  300/300 pass. `coord-node-held-stress` (`--rerun-each=100`, pinned to one core
  beside 6 busy loops): 100/100 pass. `coord-node-file-stress` (whole owner,
  `--rerun-each=10`, same contention): pass. No source changed.

