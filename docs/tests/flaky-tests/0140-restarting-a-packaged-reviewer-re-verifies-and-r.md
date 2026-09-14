# Resolved: `restarting a packaged reviewer re-verifies and reuses the read-only package prompt` (`apps/backend/src/core/multi-review-service.test.ts:5107`)

- **ID:** 0140
- **Status:** resolved
- **Observed:** 2026-09-07, during coordinator multi-provider work.
- **Command:** `bun --cwd=apps/backend test --preload ../../tests/setup-node.ts src --parallel`
  (Bun's default worker count on this host).
- **Suite counts:** 2,627 total, 2,626 passed, 1 failed across 114 files.
- **Failure message:** the 2026-09-10 `mise run test` aggregate expected phase
  `reviewing` but observed `consolidating` after 35.31 ms. The workspace group
  reported 2,987 passed, 1 skipped, and 1 failed across 134 backend files.
- **Isolated rerun:** `bun --cwd=apps/backend test --preload ../../tests/setup-node.ts
  src/core/multi-review-service.test.ts -t "re-verifies and reuses the read-only package prompt"`
  → 1 passed, 0 failed, repeated three times.
- **2026-09-10 isolated rerun:**
  `mise run test:logged -- --name multi-review-service-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/multi-review-service.test.ts --parallel=1 --only-failures` passed
  the owner in 6.3 seconds.
- **Root cause:** the test changed the provider-wide status to `idle` to finish
  package preparation. `start()` deliberately launches background supervision;
  when the explicit `advanceNow()` joined that still-running pass, `runLocked`
  consumed its queued pass before resolving. The newly admitted reviewer then
  inherited `idle`, completed immediately, and advanced the workflow to
  `consolidating`. Isolated scheduling usually let the startup pass settle
  first, hiding the fixture error.
- **Fix:** mark only the preparation session idle through the provider's
  per-session status override. A queued reviewer pass now observes the default
  `running` state, making the test independent of scheduler pass count while
  preserving every package-integrity, prompt-reuse, and read-only assertion.
- **Verification:** the exact case passed 100 consecutive reruns in 3.3
  seconds, and its complete owning file passed in 6.2 seconds. The final
  `mise run test` passed all four groups: workspace in 137.2 seconds,
  root/agent-support in 89.9 seconds, bridges in 75.1 seconds, and the protocol
  lockfile check in 530 ms.
