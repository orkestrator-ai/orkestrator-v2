# Claude cold-dispatch restart resend answered 503 under aggregate load

- **ID:** 1308
- **Status:** open
- **Date observed:** 2026-10-28
- **Test:** `a restarted Claude bridge answers a cold dispatch from disk without registering the session`
- **File:** `apps/backend/tests/claude-cold-dispatch-restart.test.ts:132`
- **Original command:** `mise run test:logged -- --name default-suite -- mise run test` on branch `todo-0430-first-prompt-naming-retries-9581e8c92dc4` (based on `79f3bc97e`), macOS 27.0 arm64, shared host with other sessions' suites (load averages about 17 to 38 shortly after).
- **Failure:** the resend of the never-seen request id (`POST /session/:id/prompt`, `requestId: "never-seen"`) returned 503 instead of 202 after 10,587 ms; the earlier `lost-ack` resend had already returned 410.
- **Isolated rerun:** the complete unchanged owner passed alone (`cold-dispatch`, 0.8 s).
- **Hypothesis:** the restarted bridge was not ready to take a new prompt within the test's wait under host load. Not established. The branch changed only first-prompt rename backoff, which this test does not reach. No assertion, timeout or skip changed. Related: [1147](../aggregate-validation-runs/1147-provider-non-delivery-proof-0223-validation.md), which fixed a 500 on the same resend step.

## 2026-11-02 storage review recurrence

`mise run test:logged -- --name review-default-rerun -- mise run test`
repeated HTTP 503 instead of 202 at line 133 after 11,402.74 ms.
The backend aggregate used the task's parallel worker allocation. The unchanged
complete owner passed in the focused two-file command
`mise run test:logged -- --name isolated-workspace-failures -- bun test --cwd apps/backend ./src/core/design/operations.test.ts ./tests/claude-cold-dispatch-restart.test.ts --parallel=1 --only-failures`
(12.4 s for both owners). The same owners passed in a separately installed
detached origin/main worktree at 38d55ee14 (12.2 s).
This establishes an isolated pass, not an aggregate pass on main.
The host-load/readiness hypothesis remains unproven. No test was loosened.
Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vo7cWm/`.
