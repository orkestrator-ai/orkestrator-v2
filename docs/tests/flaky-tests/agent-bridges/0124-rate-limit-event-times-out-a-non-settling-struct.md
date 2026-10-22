# `rate_limit_event > times out a non-settling structured request without blocking turn completion` (`bridges/claude-bridge/src/services/session-manager.test.ts:11606`)

- **ID:** 0124
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fixes2-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` alongside the workspace, root, and protocol-lockfile groups, while two unrelated agent sessions ran their own suites against the same clone. System load average was above 10 for the whole run.
- **Failure:** `expect(received).toBeGreaterThanOrEqual(expected)` at `session-manager.test.ts:11617` — expected `>= 950`, received `945` (duration: 1,002.35 ms). The turn itself behaved correctly: `StructuredUsageRequestTimeoutError: Structured usage control request timed out after 1000ms` was raised as designed and the session still settled to `idle`.
- **Suite counts:** Bridge group: 2,470 total, 2,458 passed, 11 skipped, 1 failed across 70 files in 37.80 seconds.
- **Isolated rerun:** `set -o pipefail; bun test bridges/claude-bridge/src/services/session-manager.test.ts` -> 397 passed, 0 failed in 9.18 seconds; the target passed. Evidence: `/tmp/ork-verify-session-manager.log.gz`.
- **Hypothesis:** Not the usual contention-makes-it-slower shape — the measurement came in 5 ms *under* the floor, so the failure is that a nominally 1,000 ms timer completed in 945 ms of `Date.now()` wall time. `startedAt` is captured before `runPromptWithMessages`, so the elapsed span strictly contains the timer and should never be shorter than it. That points at wall-clock versus timer-clock divergence (Bun schedules the timeout on a monotonic clock while the assertion measures `Date.now()`), which a loaded machine or an NTP slew can widen past the assertion's 50 ms lower tolerance. A recurrence should record whether the shortfall grows with load before the tolerance is widened; measuring the span with a monotonic source such as `performance.now()` would remove the coupling without weakening the upper bound.
