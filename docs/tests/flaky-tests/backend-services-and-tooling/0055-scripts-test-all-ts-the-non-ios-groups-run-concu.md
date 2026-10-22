# `scripts/test-all.ts > the non-iOS groups run concurrently, not one after another` (`tests/unit/test-all.test.ts`)

- **ID:** 0055
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** root group at four workers while the other aggregate
  groups ran concurrently.
- **Failure:** Expected the root group to have started, but `started` was still
  empty after the test's fixed five-millisecond delay (10.59 ms).
- **Suite counts:** Root group: 3,682 passed, 1 skipped, 1 failed across 146
  files; other root tests passed.
- **Isolated rerun:** `bun test ./tests/unit/test-all.test.ts --only-failures`
  passed.
- **Root cause:** Artifact-retention pruning now precedes group construction.
  On a busy host it can legitimately take longer than the test's arbitrary
  five-millisecond scheduling assumption.
- **Fix:** Poll the observable group-start boundary for up to one second. A
  genuinely sequential implementation still cannot pass because the first
  group remains deliberately gated.
- **Verification:** Focused runner tests and the complete concurrent suite pass.
- **Recurrence (2026-08-17, `claude-task-layout`):** failed again at 1008.70 ms in a
  full `bun run test`, which is the one-second poll the fix above installed rather
  than the original five-millisecond assumption — so the observable group-start
  boundary took longer than a second to appear. The same run also hit the
  5000 ms-deadline cluster documented above and took 229.6 s against ~137 s for
  the identical command minutes earlier on the same tree, so the host was
  materially slower throughout. `bun test tests/unit/test-all.test.ts` passed
  alone immediately afterwards (32 passed, exit 0).
- **Next step:** the fix chose a bound where it needs a signal. Polling longer
  would move the same threshold again; what the test actually wants is to wait on
  the group-start boundary without a deadline and let the suite-level timeout be
  the only limit, or to assert concurrency from the recorded start/end ordering
  after the run rather than by sampling it live. Do not simply raise the second.
