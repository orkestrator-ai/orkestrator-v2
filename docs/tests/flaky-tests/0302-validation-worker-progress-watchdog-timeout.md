# Validation worker progress-watchdog case exceeds the aggregate deadline

- **ID:** 0302
- **Status:** open

Observed: 2026-10-17

- Test: `stdout and stderr progress reset the ordinary command watchdog`
- Owner: `apps/backend/src/core/review-validation-worker.test.ts:633`
- Original command: `bun run test` from `apps/backend` (`bun test --preload ../../tests/setup-node.ts src tests --parallel`) on `53b43e81`, the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`, macOS arm64 under shared-host load (load average 18–28).
- Aggregate: Backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners: this case, 0165 (two cases), 0248 (two cases) and one other new record ([0301](0301-looped-review-lease-takeover-timeout.md)).
- Failure: default 5000 ms timeout, observed duration 5440.14 ms.
- Isolated rerun: `bun test --preload ../../tests/setup-node.ts src/core/review-validation-worker.test.ts` from `apps/backend` passed the unchanged owning file, 46 of 46 in 53.83 seconds.

Hypothesis: the case spawns a real child process whose output cadence slows
under host load, like [0227](0227-validation-cooperative-groups-incomplete.md) and
[0260](0260-validation-worker-stopped-output-empty.md) in the same owner. That is
unconfirmed. No assertion, deadline or skip was changed.
