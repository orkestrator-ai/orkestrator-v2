# Agent Mail service aggregate timing cluster

- **ID:** 0150
- **Status:** open
- **Date observed:** 2026-09-19
- **Tests:** `AgentMailService > converges the mailbox directory after tabs open
  and close`, `AgentMailService > delivers mail that arrives during a drain
  without retrying a held sibling`, and `AgentMailService > rechecks deferred
  delivery and injects as soon as the recipient is idle`
- **File:** `apps/backend/src/core/agent-mail-service.test.ts:306`
- **Original command:** `mise run test`
- **Worker configuration:** the aggregate workspace group ran package tasks in
  parallel; the backend suite used its normal Bun test runner configuration.
- **Failure:** the directory-convergence case still observed `agent` instead of
  `agent-2` after its fixed wait, the drain case observed zero dispatches, and
  the deferred-delivery case failed with `ENOENT` while renaming a temporary
  `agent-mail.json` in the test storage directory.
- **Isolated rerun:**
  `mise run test:logged -- --name agent-mail-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts --parallel=1 --only-failures`
  passed all owning-file tests unchanged in 2.0 seconds.

## Current assessment

This is a credible aggregate-only failure cluster. The first two symptoms occur
at fixed asynchronous convergence deadlines under aggregate contention. The
temporary-file rename failure may be teardown fallout after the earlier cases
miss those deadlines, but that relationship has not been established. Keep the
case open until the ordering and lifetime of Agent Mail's background writes are
made deterministic or repeated aggregate evidence identifies a narrower cause.
