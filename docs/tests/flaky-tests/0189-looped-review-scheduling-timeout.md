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
