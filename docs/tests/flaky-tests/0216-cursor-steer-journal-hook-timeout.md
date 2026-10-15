# Cursor bridge 300-steer bound test hook times out under aggregate load

- **ID:** 0216
- **Status:** resolved

Observed: 2026-10-15

- Test: `steer route > 300 steers against one run stay bounded; the overflow is refused before delivery`
- Owner: `bridges/cursor-bridge/src/steer-journal.test.ts`
- Original command: `mise run test`
- Worker configuration: four aggregate groups running concurrently; the bridges group ran the Cursor bridge through Turbo with the other bridge packages.
- Failure: "a beforeEach/afterEach hook timed out for this test", observed duration 10010.58ms.
- Cursor bridge result: 720 pass, 1 fail in 27.23 seconds.
- Evidence: `/tmp/orkestrator-test-run.qhT3jO/bridges.log.gz`.
- Isolated rerun: `bun test ./src/steer-journal.test.ts` from `bridges/cursor-bridge` passed unchanged: 21 pass, 0 fail in 0.80 seconds.

Hypothesis: the test's setup or teardown hook does enough file-backed journal
work for 300 steers that it overruns the hook deadline when the host is
saturated by the concurrent groups. The test source was neither changed nor
skipped. The branch under test (`chore-2026-10-14-cleanup-follow-ups`) does not
touch `bridges/`.

## Resolution (2026-10-15)

The hypothesis held, and the cost is the flushes. Each of the roughly 600
publications fsyncs the temporary file and its directory. That is cheap on
macOS and slow on a loaded Linux disk; case 0240 has the measurement (1,026
fsyncs in its 256-steer case). A temporary copy of the unchanged case with a
simulated 10 ms fsync failed with the same signature (`[10003.42ms]`, "a
beforeEach/afterEach hook timed out").

The case now replaces `fsyncFile` and `fsyncDirectory` with no-ops through
`usePersistenceFsForTests` for its own body. Writes, renames and the published
file it reads back stay real. `persistence-durability.test.ts` owns the flush
ordering. Under the simulated 10 ms fsync it passes.
