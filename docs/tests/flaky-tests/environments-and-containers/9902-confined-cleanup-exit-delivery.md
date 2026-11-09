# Confined cleanup exit delivery

Status: resolved (2026-11-09).

Test: `delete_environment host cleanup > Retry stays fenced after a confined helper is killed until its exit is delivered`, in `apps/backend/src/core/commands-environment-cleanup.test.ts`.

Observed in the recorded `mise run test:logged -- --name review-default-tests -- mise run test` at reviewed commit `82d72b5260d6044f22e7854738db063a36e5ac41`, base `8a2aba3dad30b66d33d41da93e7fc5978d6520a0`. The aggregate reported four failures (32,023 tests total); this case expected SIGKILL and received null after 393.77 ms. The backend used two parallel workers. Original evidence is retained in `.orkestrator/review-artifacts/review-validation-3ce5872a-8954-4cf9-9d2e-147a5b665c8f/validation-04.stderr.txt`.

The owning file passed in the focused six-file owner run (264 tests), before the repair. This establishes intermittent behavior, not a product failure. This is a new case, not a counted recurrence.

The test used a real removal helper and expired the deadline in a microtask. Helper exit could beat abort delivery, so SIGKILL was not guaranteed. The repair replaces only that spawn with an EventEmitter child and an impossible fake PID. Its kill records the signal and parks exit until the test releases it. Assertions still require SIGKILL, a pending deletion, rejection of another deletion while fenced, and release only after exit delivery. This tests the intended acknowledgement boundary without racing process completion.

Validation: `mise run test:logged -- --name cleanup-repair -- bun test --cwd apps/backend ./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures` passed. Aggregate rerun evidence is recorded in the Address Findings result.
