# Interaction hold fixture stamped the pause before the request

- **ID:** 0878
- **Status:** resolved
- **Date observed:** 2026-10-25 (CI run of 2026-10-24)
- **Test:** `pausing an interaction's deadline through the HTTP bridges > Claude: a pause that is already in place, or a resume of a running one, sends nothing`
- **File:** `apps/backend/src/core/agent-provider-interaction-holds.test.ts:110`
- **Original command:** CI `main` run 40041601608 (#1205, 2026-10-24), job "Unit and integration tests", `mise run test`.
- **Failure:** `holdInteraction` resolved `{ result: "rejected", revision: 1 }` instead of `applied` (0.86 ms).
- **Occurrences:** 1 of the 44 failing `main` CI runs from 2026-10-23 to 2026-10-25.
- **Root cause:** the call `claudeQuestion({ hold: { available: true, heldAt: Date.now() } })` evaluates `heldAt` before `claudeQuestion` reads `requestedAt = Date.now()`. When a millisecond boundary fell between the two reads, `heldAt < createdAt`, which `isAgentInteractionHold` (`packages/protocol/src/agent-interactions.ts`) rightly treats as malformed. The hold became `bridge-outdated` and the pause was rejected.
- **Reproduction:** stamping the hold at `requestedAt - 1` gives the CI failure exactly (`rejected`, revision 1).
- **Fix:** on branch `todo-0030-test-suite-ci-health-e11a519267e2`, the test reads the clock once and passes the same value as `requestedAt` and `heldAt`. The owner passes 8 of 8.
