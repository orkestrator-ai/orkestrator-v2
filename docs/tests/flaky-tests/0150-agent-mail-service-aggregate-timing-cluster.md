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

## Recurrence on 2026-10-11

The directory-convergence case timed out at 5001.72 ms during
`mise run test:logged -- --name final-suite -- mise run test`, using the testing
guide's macOS GNU-tool PATH. The workspace group used two slots and the backend
runner used `--parallel=1`; root, bridge, and protocol groups also ran on the
host. The owning file passed unchanged in 2.1 seconds with
`mise run test:logged -- --name agent-mail-final-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts --parallel=1 --only-failures`.
Aggregate evidence is in
`/tmp/orkestrator-test-run.w2YALW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No test was skipped or loosened.

## Recurrence on 2026-10-13 (project navigation validation)

The GNU-tool PATH command `mise run test:logged -- --name full-tests -- mise run test`
failed `AgentMailService > converges the mailbox directory after tabs open and close`
at 695.82 ms: the directory still contained `agent-2` after its removal and the
fixed 325 ms wait. Workspace packages used one Bun worker each with two package
tasks; root, bridge and protocol groups were also active.

Backend totals were 5,875 passed, 15 skipped and 27 failed across 329 files in
442.53 seconds. Twenty-two failures reproduced as tmux cleanup errors on this
host and are separate from this convergence flake.

The owning file passed unchanged, exit 0, in 4.7 seconds with the same PATH:
`mise run test:logged -- --name agent-mail-rerun -- bun --cwd=apps/backend test ./src/core/agent-mail-service.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

Evidence: `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The fixed-wait convergence failure matches this existing aggregate timing case.
No test was skipped or loosened.

Recurrence 2026-10-18: `AgentMailService > upgrade reconciles legacy refused mail (verifying, canonical session=false)` hit the 5000 ms deadline at 5013.63 ms in `mise run test:logged -- --name mcpq-full -- mise run test` on branch `qualify-mcp-inactive-apply-9ec53f801117` (no Agent Mail changes; heavily loaded host). The owning file passed unchanged alone (`bun test src/core/agent-mail-service.test.ts` from `apps/backend`: 39 pass, 0 fail, 2.7 s). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.O8FSrv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
