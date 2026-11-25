# Cursor prompt journal loses the replacement entry on restart

- **ID:** 10005
- **Status:** resolved
- **Observed:** 2026-11-19, Linux x86_64, Agent Capabilities review repair.
- **Validated branch commit:** `c84d647e66f27bda0731ce61fcb8ca6018ff0d80`, base
  `fe9d1f5d63541eb7fd3e295909dcbeec8de8a6e4`.
- **Owning file:** `bridges/cursor-bridge/src/http-prompt-outcome.test.ts:271`.
- **Test:** `prompt journal retention > discarding an ambiguous id frees capacity and survives restart`.

`mise run test:logged -- --name review-default-tests -- mise run test`
failed. The bridges group had two worker slots and Cursor reported 972 passing
tests and one failure. After clearing the in-memory maps and loading disk
state, the assertion for the replacement entry expected `true` and got
`undefined` (43.97 ms).

The aggregate runner reran the owning file alone with one worker slot and
passed in 689 ms. The underlying persistence failure has not been diagnosed.
The capability repair does not change the Cursor bridge or this test.

Compressed validation output is in
`/tmp/orkestrator-test-run.bvmoTF/review-default-tests.log.gz`.

## Resolution (2026-11-25)

- **Root cause:** the test simulated a restart by clearing the session map and
  loading the state file. The old process's queued best-effort write still ran:
  it snapshots when it starts, so it published the empty map over the file being
  read. A dead process writes nothing, so this is a defect of the simulation.
- **Fix:** `RouterHarness.restart()`
  (`bridges/cursor-bridge/src/testing/router-harness.ts`) keeps the published
  bytes, clears the maps, lets the write queue run out, puts the bytes back and
  loads them. The six router-harness suites that simulated a restart by hand use
  it. No product code and no assertion changed.
- **Reproduced:** yes.
  `bun scripts/test-under-contention.ts --core 1 --burners 6 -- bun test src/http-prompt-outcome.test.ts --isolate --rerun-each=60`
  failed this test 7 of 60 times (593 pass, 7 fail). With the fix, the same
  command at `--rerun-each=150` passed 1,500 of 1,500.
- **Stress:** the command above; the whole package then passed
  (1,007 pass, `--parallel=4`).
