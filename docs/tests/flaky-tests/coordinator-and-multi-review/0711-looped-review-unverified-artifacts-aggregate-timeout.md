# Looped review package refusal times out in the aggregate suite

- **ID:** 0711
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `generateLoopedReviewPackage > refuses a command that ran but names no verified artifacts`
- **File:** `apps/backend/src/core/commands-review.test.ts`
- **Original command:** `mise run test:logged -- --name test-final -- mise run test` (complete non-iOS suite) while two live `slash-command-inactive.spec.ts` runs drove a `dev:test` profile and a container on the same host.
- **Worker configuration:** the runner's default reservations; the workspace group ran backend tests with its default worker count.
- **Failure:** timed out at 5,011 ms; the workspace group failed with four other load timeouts (0661, 0691 cluster, 0518) and one real failure fixed in the same change.
- **Isolated rerun:** `bun test ./src/core/commands-review.test.ts` from `apps/backend`: 19 pass, 0 fail.
- **Assessment:** a 5 s default test timeout under host load; no evidence of a logic race.
