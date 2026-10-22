# Looped-review persisted-fixture equivalence times out in the aggregate

- **ID:** 0189
- **Status:** open
- **Date observed:** 2026-10-11
- **Test:** `LoopedReviewService keyed scheduling > old and new drivers make the same transitions from one persisted fixture`.
- **File:** `apps/backend/src/core/looped-review-scheduling.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests-final -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** backend `--parallel=1`, alongside the web package and other aggregate groups; isolated browser validation was also active.
- **Failure:** the case exceeded its 5000 ms deadline (5002.08 ms). The superseded aggregate was later interrupted, so its workspace completion is not clean handoff evidence.
- **Evidence:** `/tmp/orkestrator-test-run.DjXKcv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name looped-scheduling-isolation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/looped-review-scheduling.test.ts --parallel=1 --only-failures` passed (exit 0, 5.7 seconds).
- **Hypothesis:** fixture setup and scheduling ran slowly under concurrent host activity. The isolated pass establishes intermittent behavior but does not identify the stalled operation. No assertion, timeout or skip was changed.

## Recurrence — 2026-10-12

Observed while validating Claude retained-runtime fencing. The owning backend
code was unchanged.

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`,
  with the testing guide's macOS GNU-tool PATH.
- **Workers:** workspace two slots (one Bun worker per package), root three,
  bridges two, protocol one. A focused Claude bridge package run also ran.
- **Failure:** the persisted-fixture case exceeded 5000 ms (5006.66 ms).
  Its timed-out continuation then read a removed fixture and raised
  `TypeError: null is not an object` in `workflowOf`.
- **Suite counts:** backend 5772 pass, 15 skip, 2 fail, 1 unhandled error;
  5789 tests across 323 files. The other failed case was flake 0177.
- **Isolated rerun:** `mise run test:logged -- --name looped-review-isolated -- bun test --cwd apps/backend ./src/core/looped-review-scheduling.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed, exit 0 (2.8 s).
- **Evidence:** `/tmp/orkestrator-test-run.3FTW4U/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the existing concurrent-load timeout recurred. Fixture cleanup
  after the timeout explains the subsequent null read, but the slow operation
  remains unconfirmed. No timeout, assertion or skip changed.
