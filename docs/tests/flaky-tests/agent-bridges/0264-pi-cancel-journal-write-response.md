# Pi cancellation journal-write response differs in the aggregate

- **ID:** 0264
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Test:** `cancel during the mandatory journal write > a write failure after a cancel releases the claim and its intent`
- **File:** `bridges/pi-bridge/src/http-cancel-startup.test.ts:526` at observation
  (the assertion is at line 533 after the fix).
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  with the testing guide's GNU-tool directories preferred in PATH, while merging
  `origin/main` at `44471e25` into `todo-design-flake-ordering-a295739d3dc2`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; bridges used two package tasks with one isolated Bun worker each.
  Another worktree was validating on the same host.
- **Failure:** after cancellation and rejection of the held journal write, the
  prompt response was HTTP 202 instead of the expected HTTP 500 (6.23 ms).
- **Suite counts:** Pi reported 531 passed, one skipped and one failed across
  533 tests in 25 files (7.62 seconds). The other four bridge packages passed;
  the bridge group exited 1 after 88.1 seconds. Workspace, root and protocol
  groups passed; the aggregate exited 1 after 382.8 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-pi-cancel-isolated -- bun test --cwd bridges/pi-bridge --preload ../../tests/setup-node.ts ./src/http-cancel-startup.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 0.5 seconds).
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xklZLk/bridges.log.gz`;
  outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.H2hdLx/merge-tests.log.gz`.
- **Disposition (at observation):** intermittent failure confirmed by the
  owning-file pass. The cause was unconfirmed at the time.

## Recurrence on GitHub Actions

`main` run 38975828723 failed the same assertion during `bun run test:bridge`
in `bridges/pi-bridge`: `Expected: 500, Received: 202` (6.5 ms). The log also
showed `[pi-bridge] Unexpected HTTP route failure`, which is the expected 500
path of a *different* request in the same file.

## Root cause

A test artefact: the test waited for the wrong write.

The test installs a write gate with `setPersistWriteGateForTests`, waits until
it has counted one write (`writes >= 1`), cancels, then rejects the gate and
expects the prompt's mandatory journal barrier to fail with 500. But the gate
held *every* state-file publication. In `handlePrompt` (`src/http.ts`),
`setPromptJournal` records the prepared entry and calls `schedulePersist()`
synchronously, long before the route reaches `await persistBarrier()`. That
best-effort write reaches the gate first, while the route is still awaiting
attachment reads, `reconcileAgentMcp`, `ensureSession` and
`applyComposerToSession`. So `writes >= 1` did not mean "the journal barrier
is held".

If the cancel's HTTP round trip finished before the route passed its last
pre-barrier `stopIfCancelled()`, that check threw `CancelledBeforeSendError`.
The prompt then settled locally as cancelled-before-send and answered
`202 { accepted: true, cancelled: true }`. The rejected gate only failed the
swallowed best-effort write. Normally the route reaches the barrier first,
because the scheduled write's `mkdir` and the cancel's round trip are slower
than in-memory preparation. Under CI load the order can flip.

The production behaviour is correct in both orders. A cancel before the
barrier is honoured at the earlier boundary. A barrier failure after the
cancel still releases the claim and returns 500.

**Reproduced before the fix:** a temporary copy of the unchanged test with a
30 ms delay in its `hydrateComposer` hook, which lengthens preparation after
the scheduled write is gated, failed deterministically with the CI signature:
`Expected: 500, Received: 202` at line 526. The same delay applied to all
three `cancel during the mandatory journal write` tests passes after the fix
(3 pass). Running the original test under plain host CPU stress (one busy
loop per core plus a concurrent `bun run test:bridge`,
`--rerun-each 60`, 1,380 tests) did not reproduce it on this macOS host.

## Fix (this branch)

- `bridges/pi-bridge/src/persistence.ts`: the test write gate now receives a
  `PersistWriteForTests` descriptor, `{ barrier: boolean }`. It is `true` only
  for writes issued by `persistBarrier`. Scheduled and shutdown writes pass
  `false`. Production write behaviour, serialisation and failure propagation
  are unchanged. Existing zero-argument gates in other suites are unaffected.
- `bridges/pi-bridge/src/http-cancel-startup.test.ts`: a
  `holdBarrierWrites(gate)` helper holds only barrier writes and lets
  best-effort writes pass. All three tests in
  `cancel during the mandatory journal write` now wait for
  `barriers.held >= 1`. This proves the route is parked in its journal
  barrier, past every earlier `stopIfCancelled`, before they cancel or delete.
  No assertion, timeout or skip changed.

## Verification

From `bridges/pi-bridge`, on macOS arm64, with other agents' suites loading the
host at the same time:

- Owning file 50 times in a loop:
  `bun test --preload ../../tests/setup-node.ts ./src/http-cancel-startup.test.ts`
  gave 50/50 passing runs, 0 failures.
- Under stress: one `sh -c 'while :; do :; done'` per core plus a concurrent
  `bun run test:bridge`, running
  `bun test --preload ../../tests/setup-node.ts ./src/http-cancel-startup.test.ts --rerun-each 60`.
  Result: 1,380 pass, 0 fail. The concurrent package suite passed (532 pass,
  1 skip, 0 fail). An earlier stress round of `--rerun-each 30` alongside two
  concurrent `bun run test:bridge` runs gave 690 pass, 0 fail, and both package
  runs passed.
- With the deterministic 30 ms preparation delay described above: 3 pass,
  0 fail.
- Package suite `bun run test:bridge`: 532 pass, 1 skip, 0 fail, 533 tests
  across 25 files.
- `bun run typecheck` in `bridges/pi-bridge`: exit 0.
- `bunx oxfmt --check` and `bunx oxlint` on both touched files: clean.
