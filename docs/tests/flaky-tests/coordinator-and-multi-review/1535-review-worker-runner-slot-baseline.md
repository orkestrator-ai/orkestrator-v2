# Review validation worker runner-slot case failed once in a baseline run

- **ID:** 1535
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `a cooperative command queued on the host does not hold the local runner slot`
- **File:** `apps/backend/src/core/review-validation-worker.test.ts:1474`
- **Original command:** a baseline `mise run test` during todo 0030's
  2026-10-25 round (its item 4 work on this owner).
- **Failure:** failed once; the message was not captured.
- **Isolated rerun:** passed alone and in three full runs.
- **Hypothesis:** none. Created on 2026-10-31 from the triage note in todo
  0030; the only evidence is that note. Next recurrence: keep the message and
  the worker's state file, since the case watches that file rather than a
  control process.

## Investigation — 2026-11-06

Still open; no failure message was ever captured. One weak point is that the
first wait loop accepts any `queued` status. The worker reports this command
`queued` twice: once locally, before it spawns the child, and again only after
the child's admission publishes its host wait. Between the two it reports
`running`, and the loop gives up silently after 8 s. So the later
`expect(...status).toBe("queued")` could read `running` if a loaded host delayed
the child's start. Attempts to reproduce failed. A 1.5 s sleep injected at the
top of the child script passed (`coord-1535-repro`), and so did a Git wrapper
that slept 0.5 s per call (`coord-1535-repro2`, 3/3). The test also passed under
one-core contention. No change was kept. On recurrence, keep the assertion
message and the worker's `state.json`.

## Resolution (2026-11-15)

- **Class:** silent wall-clock deadlines (B). The test now lives in `apps/backend/src/core/review-validation-worker.cooperative.test.ts`.
- **Root cause (from the code, as the 2026-11-06 investigation found):** the first loop gave up silently after 8 s and accepted any `queued`, including the local report the worker makes before the child exists; the second gave up silently after 5 s waiting for the independent command's marker. Either could fall through on a slow host and leave the following assertions reading an intermediate state.
- **Fix:** both loops are replaced by `observeUntil` on the worker's state: first until the cooperative command is `queued` with a `queueReason` (only the child's host admission sets one), then until the independent command is `passed`. The final assertion checks the same host-queued predicate. The file's `setDefaultTimeout` goes from 30 s to 60 s and the test's 30 s third argument is removed, so the `observeUntil` bounds are hang watchdogs only.
- **Reproduced:** no; the original message was never captured, and the earlier delay injections passed.
- **Stress:** `mise run test:logged -- --name c1535 -- bun scripts/test-under-contention.ts --core 11 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.cooperative.test.ts --rerun-each=3` passed (66.5 s).
