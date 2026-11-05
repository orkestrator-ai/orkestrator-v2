# Pi session-list timeout can precede the read

- **ID:** 5105
- **Status:** open
- **Observed:** 2026-11-05
- **Test:** `the resumable session list > a timeout is reported, not an empty history, and stops the read`
- **File:** `bridges/pi-bridge/src/session-list-cache.test.ts:165`

## Aggregate observation

During the S-0270 iOS review follow-up at `5a53c1eff`, `mise run test:logged -- --name address-full-tests -- mise run test:all` failed this assertion: `expect(signal?.aborted).toBe(true)` received `undefined`. The test took 32.81 ms. The Pi package reported 761 passed, 2 skipped and 1 failed (764 tests across 43 files, 41.91 s). The bridge group held two worker slots, with package test files using `--parallel=1`; the browser suite was also running on this host.

The branch changed only iOS sources/tests and security documentation. No Pi source or test was changed.

## Isolated rerun

```bash
mise run test:logged -- --name pi-session-list-rerun -- bun test --cwd bridges/pi-bridge --preload ./src/testing/test-isolation.ts ./src/session-list-cache.test.ts --parallel=1 --only-failures
```

Passed, exit 0, 3.7 s. The credential-isolation preload was used. No test was skipped or loosened to obtain this result.

## Investigation

The aggregate diagnostic shows the timeout was reported but the test's captured read signal was still undefined. Scheduling relative to the test's 5 ms timeout is a possible cause; the isolated pass establishes a flake, not its root cause. No production or test implementation was changed as part of the iOS work.
