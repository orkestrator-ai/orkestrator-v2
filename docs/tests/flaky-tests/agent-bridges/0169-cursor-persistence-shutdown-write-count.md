# Cursor persistence shutdown write count varies in the full suite

- **ID:** 0169
- **Status:** resolved
- **Date observed:** 2026-09-28
- **Test:** `dispatch around the write queue > shutdown racing a settling run has one writer, no unhandled rejection and a valid final file`
- **File:** `bridges/cursor-bridge/src/persistence-durability.test.ts:501`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on commit `6449cc3a`. The bridge is unchanged by this commit. Another checkout was running its repository suite on the same host.
- **Failure:** `expect(hold.writes()).toBe(2)` received `3`. The bridge group had 667 passing tests and this one failure; the workspace, root and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name cursor-persistence-isolated -- bun test ./bridges/cursor-bridge/src/persistence-durability.test.ts --parallel=1 --only-failures` passed.

## Current assessment

The shutdown test depends on the number of queued persistence writes observed after a run settles. The aggregate and isolated results differ. The bridge was not changed in this task; investigate the write scheduling and assertion before marking this resolved.

## Resolution (2026-09-30)

The extra write came from the dispatch, not the shutdown. The prompt route
answers 202 and then journals the prompt, and every journal transition
schedules a best-effort write (`prompt.ts`, `journal()` → `schedulePersist()`).
If that write had taken its snapshot but not yet reached `writeFile` when the
test installed `holdPublication()`, the hook counted it and held it. The
test's own `schedulePersist()` then queued a second write on the tail behind
it. `drainPersistence()` resets `pending` but still chains the final snapshot
after the queued write, so three writes reached the hook. On a quiet host the
dispatch write finished before the hook was installed and only two were
counted.

The test now awaits `persistBarrier()` after the 202 and before installing the
hook. That is the same quiescence step the other `holdPublication()` tests
already take. The run is held, so nothing else schedules a write until the
test resolves it. The assertion (`writes() === 2`) is unchanged.

Reproduction: a scratch copy of the original test slowed the dispatch write's
`mkdir` by 30 ms (the `await` between `persistNow`'s snapshot and its
`fs.writeFile`, which reads the swappable fs at call time). It failed
deterministically with the recorded `Expected: 2, Received: 3`. The same copy
with the `persistBarrier()` passed. On a quiet host, 100 repetitions of the
original test did not reproduce it.

Verification: `bun test ./bridges/cursor-bridge/src/persistence-durability.test.ts --parallel=1 --rerun-each 30 -t "shutdown racing"`
passed 30/30 while a full `mise run test` loaded the host.
