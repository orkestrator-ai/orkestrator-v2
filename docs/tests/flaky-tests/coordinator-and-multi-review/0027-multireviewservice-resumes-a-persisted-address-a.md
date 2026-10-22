# `MultiReviewService resumes a persisted address attempt after restart` (`apps/backend/src/core/multi-review-service.test.ts:732`)

- **ID:** 0027
- **Status:** resolved
- **Date observed:** 2026-08-26
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; the
  failure was in the backend workspace package.
- **Failure:** the final environment snapshot was expected to contain
  `agentActivitySources: { "multi-review": { state: "idle" } }`, but the source
  and aggregate activity remained `working` after the restarted service cleared
  the persisted address attempt.
- **Suite counts:** complete run — 9,810 total, 9,796 passed, 12 skipped, 2
  failed. The other failure was the deterministic bounded-DOM assertion fixed
  in the same change.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts` from
  `apps/backend` -> 73 passed, 0 failed.
- **Hypothesis:** the isolated owner exercises the same persisted restart and
  activity transition successfully, so the observed failure depends on
  aggregate execution or timing. The available output does not establish a
  narrower shared-state or scheduling cause; a recurrence should capture the
  activity-source writes around shutdown, init, and pending-dispatch clearing.
- **Recurrence:** on 2026-08-27, `bun run test` reproduced the same expected
  `idle` / received `working` activity mismatch after 127.76 ms in the backend
  workspace group (`2,192 passed, 2 failed` across 2,194 tests). The owning file
  immediately passed 79/79 in isolation; the other aggregate failure was the
  related missing-consolidation-session case recorded below.
