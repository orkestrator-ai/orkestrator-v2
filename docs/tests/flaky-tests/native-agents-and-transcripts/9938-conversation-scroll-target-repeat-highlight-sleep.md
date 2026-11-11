# Conversation scroll target: repeat highlight ended before a fixed sleep

- **ID:** 9938
- **Status:** open
- **Date observed:** 2026-11-11

Test: `useConversationScrollTarget > a repeat jump to the same message restarts the highlight; another moves it`
in `apps/web/src/components/native-agent/useConversationScrollTarget.test.tsx`.

No existing index entry matched this test or file; this records a new case,
not a counted recurrence.

## Observation

- **Branch:** `tmux-loop-graph-54120f5545fd-r1`, base `498b68766` (`main`).
  The branch changes only backend code, docs and the protocol's recurring-work
  catalogue; the test's import graph reaches none of it.
- **Original command:**
  `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name default-tests-skip-guards -- mise run test`
  (default tier, all groups concurrently on the local Linux host).
- **Failure:** line 88, `expect(result.current?.messageId).toBe("u-2")`
  received `undefined` (396.98 ms).
- **Counts:** web 14,468 passed, 10 skipped, 1 failed; 14,479 tests across
  1,001 files in 478.67 s. Evidence:
  `orkestrator-test-run.WNJnWU/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Isolated rerun

The aggregate runner's automatic rerun of the unchanged owner passed alone:
11 pass, 0 fail, 2.17 s (one worker).

## Assessment

Hypothesis, unconfirmed: the test runs a 200 ms highlight on wall-clock time.
After the repeat jump it waits for the new generation and then sleeps a fixed
120 ms before checking that the highlight is still shown. When the
`waitFor` and the sleep together overrun the restarted 200 ms period on a
loaded host, the highlight has already cleared. No budget, assertion or retry
was changed for this record.

## Next evidence

If it recurs, drive the highlight timer with `installControlledTimeout`
(`tests/helpers/controlled-timeout.ts`) instead of fixed sleeps, as the
`sleep-before-negative-assertion` guard advises.
