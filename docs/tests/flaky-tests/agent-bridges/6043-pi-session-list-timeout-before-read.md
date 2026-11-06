# Pi session-list timeout can precede the read

- **ID:** 6043
- **Status:** resolved
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

### Resolution — 2026-11-06 (stale: fixed before this report was filed)

The failure is at `session-list-cache.test.ts:165`, which is the
`expect(signal?.aborted)` line of the test *before* commit `e8959f0fd`
(2026-11-05 09:39, "fix(pi-bridge): stop a timed-out session list before it
parses", case 5183). In that version the real 5 ms ceiling could expire while
the session files were being stamped, before `SessionManager.list` was called,
so `signal` was never captured. `e8959f0fd` drives both orderings with fake
timers, adds the abort check before the parse and a case proving a timeout
before the list never starts it; the assertion now sits at line 179. The
observation was on a branch (`5a53c1eff`) that did not yet contain that fix.
Same root cause as 5183.

**Verification.** `mise run test:logged -- --name br-6043-stress -- bun test --cwd bridges/pi-bridge --preload ../../tests/setup-node.ts --preload ./src/testing/test-isolation.ts ./src/session-list-cache.test.ts --rerun-each=30` passed (exit 0). No code changed for this case.
