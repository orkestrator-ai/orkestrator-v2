# Claude cold-dispatch restart resend answered 503 under aggregate load

- **ID:** 1304
- **Status:** open
- **Date observed:** 2026-10-28
- **Test:** `a restarted Claude bridge answers a cold dispatch from disk without registering the session`
- **File:** `apps/backend/tests/claude-cold-dispatch-restart.test.ts:132`
- **Original command:** `mise run test:logged -- --name default-suite -- mise run test` on branch `todo-0430-first-prompt-naming-retries-9581e8c92dc4` (based on `79f3bc97e`), macOS 27.0 arm64, shared host with other sessions' suites (load averages about 17 to 38 shortly after).
- **Failure:** the resend of the never-seen request id (`POST /session/:id/prompt`, `requestId: "never-seen"`) returned 503 instead of 202 after 10,587 ms; the earlier `lost-ack` resend had already returned 410.
- **Isolated rerun:** the complete unchanged owner passed alone (`cold-dispatch`, 0.8 s).
- **Hypothesis:** the restarted bridge was not ready to take a new prompt within the test's wait under host load. Not established. The branch changed only first-prompt rename backoff, which this test does not reach. No assertion, timeout or skip changed. Related: [1147](../aggregate-validation-runs/1147-provider-non-delivery-proof-0223-validation.md), which fixed a 500 on the same resend step.
