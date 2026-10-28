# Looped review lease-takeover case exceeds the aggregate deadline

- **ID:** 0301
- **Status:** resolved

Observed: 2026-10-17

- Test: `LoopedReviewService > expired lease takeover reconciles an ambiguous dispatch without sending twice`
- Owner: `apps/backend/src/core/looped-review-service.test.ts:1458`
- Original command: `bun run test` from `apps/backend` (`bun test --preload ../../tests/setup-node.ts src tests --parallel`) on `53b43e81`, the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`, macOS arm64 under shared-host load (load average 18–28).
- Aggregate: Backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners: this case, 0165 (two cases), 0248 (two cases) and one other new record ([0302](0302-validation-worker-progress-watchdog-timeout.md)).
- Failure: default 5000 ms timeout, observed duration 5041.98 ms.
- Isolated rerun: `bun test --preload ../../tests/setup-node.ts src/core/looped-review-service.test.ts` from `apps/backend` passed the unchanged owning file, 59 of 59 in 8.31 seconds.

Hypothesis: the lease-expiry wait in this case runs close to the default
deadline once the host is saturated. That is unconfirmed. No assertion,
deadline or skip was changed.

## Resolution (2026-10-28)

Retired, not fixed: the Looped Review feature was removed, and its owning test
file was deleted with it. The root cause was never confirmed. No surviving test
runs this case.
