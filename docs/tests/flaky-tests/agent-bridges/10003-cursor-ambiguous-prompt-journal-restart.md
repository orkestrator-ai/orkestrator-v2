# Cursor prompt journal loses the replacement entry on restart

- **ID:** 10003
- **Status:** open
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
