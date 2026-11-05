# Restore plan at the real measurement cap times out under parallel load

- **ID:** 5360
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `snapshot measurements past the cap > restore plans at the real cap stay complete and cost no blob reads`
- **File:** `apps/backend/src/core/change-tracking/measurement-file-cap.test.ts`
- **Original command:** `mise run test:logged -- --name change-tracking -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/change-tracking --parallel=4 --only-failures'`, during the E4 object-store work (efficiency report 0430, part 0550) on branch `object-store-f917b2cace0c-r1` based on `69a3b4ca5`.
- **Worker configuration:** four isolated Bun workers over the 24 change-tracking test files; host load average about 34 (other worktrees' suites running).
- **Failure:** the test exceeded Bun's 5000 ms deadline (5926.09 ms reported). Cleanup then closed the database under the timed-out turn, so the next lines are `turn.finalize-failed ... Cannot use a closed database` and an unhandled `RangeError: Cannot use a closed database` from `latestMeasurement` (`measurement-file-cap.test.ts:475`).
- **Suite counts:** 286 pass, 1 fail, 1 error across 287 tests in 23 files (22.2 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/change-tracking/measurement-file-cap.test.ts` from `apps/backend` passed the complete unchanged owning file twice (20 pass, 0 fail each); the test alone took 3.1 s.
- **Hypothesis:** the fixture writes and captures the measurement cap plus 50 files in one turn, which costs about 3 s on an idle worker, so a loaded host pushes it past the default 5 s deadline. The change under test did not touch the capture, measurement or restore paths this test exercises (it changed only the store's sweep, its byte count and retention's manifest walk, none of which this test runs). Unconfirmed: whether the same run on `main` times out; it was not repeated there.
