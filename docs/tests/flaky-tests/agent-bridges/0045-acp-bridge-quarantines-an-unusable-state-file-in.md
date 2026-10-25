# `ACP bridge > quarantines an unusable state file instead of refusing to start` (`bridges/acp-bridge/src/acp-persistence.test.ts:448`)

- **ID:** 0045
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name review-current-full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the bridges group used two Bun workers.
- **Failure:** `Timed out waiting for ACP state: false` from `acp-test-harness.ts:179`, while `spawnBridge` was waiting for the bridge to become healthy during the test at `acp-persistence.test.ts:448` (duration: 15,087.31 ms).
- **Suite counts:** 2,594 passed, 11 skipped, 1 failed; 2,606 tests across 90 files.
- **Isolated rerun:** `bun run test:logged -- --name acp-persistence-isolated -- bun --cwd=bridges/acp-bridge test src/acp-persistence.test.ts` → passed in 1.5 s.
- **Follow-up:** The bridges group passed alone in 45.3 s, and a fresh aggregate rerun passed in 91.5 s.
- **Hypothesis:** Aggregate bridge-process contention delayed readiness before the state-file quarantine behavior began. The isolated owner passed quickly, so this observation is recorded as a flake rather than a product or test assertion failure; a recurrence should capture the bridge startup timing before changing the quarantine assertions.
