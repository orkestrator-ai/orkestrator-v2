# Pi session-list timeout before the mocked read

- **ID:** 5201
- **Status:** open
- **Observed:** 2026-11-05
- **Test:** `the resumable session list > a timeout is reported, not an empty history, and stops the read`
- **File:** `bridges/pi-bridge/src/session-list-cache.test.ts:165`

## Aggregate observation

During C8 review repair validation at commit `878bb0498`,
`ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name c8-default-final -- mise run test`
failed the Pi bridge group. The aggregate admitted bridges with two worker slots;
the Pi package reported 615 pass, 1 skip and 1 fail across 41 files (37.13 s).
The failing case took 39.34 ms: `signal?.aborted` was undefined instead of true.
The test configures a five-millisecond discovery timeout.

Original group evidence: `/tmp/orkestrator-test-run.r6UgyD/bridges.log`.
The aggregate wrapper log is `/tmp/orkestrator-test-run.KoS9HV/c8-default-final.log`.

## Isolated rerun

`mise run test:logged -- --name c8-pi-failure-alone -- bun test --cwd bridges/pi-bridge --preload ./src/testing/test-isolation.ts ./src/session-list-cache.test.ts --parallel=1 --only-failures`
passed the complete owning file in 1.0 s. No Pi source or test was changed.
`git diff --name-only origin/main...HEAD -- bridges/pi-bridge` was empty.

## Investigation notes

The undefined captured signal is consistent with the five-millisecond deadline
firing before discovery reaches the mocked SDK list function. This is a
hypothesis; the isolated pass establishes intermittency, not the root cause.
Do not skip or loosen the assertion.

## Later aggregate

The subsequent `c8-default-repaired` full-suite run passed its bridge group
without changing Pi code. Its aggregate evidence is
`/tmp/orkestrator-test-run.XQvHvE/c8-default-repaired.log.gz`.
The full run still failed on the separate backend coordinator-mail assertion
and native-agent registry index mismatch; it did not fail in Pi.
