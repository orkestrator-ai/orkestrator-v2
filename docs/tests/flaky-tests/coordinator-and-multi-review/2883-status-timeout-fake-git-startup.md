# Fake Git startup can consume the status timeout

- **ID:** 2883
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `status timeout reports ETIMEDOUT and retries without fsmonitor (bun)`
- **File:** `apps/backend/src/core/review-validation-worker.test.ts:1736`

## Observation

An unintended package-wide run selected by `mise run test:logged -- --name mail-focused -- bun --cwd apps/backend test ./src/core/coordinator-node-coordinator-mail.test.ts ./src/core/control-mcp-coordinator-node-mail.test.ts ./src/core/nodes/node-mail.test.ts --parallel=2 --only-failures` failed this unchanged test at 544.32 ms. Expected two fake-Git calls; only the fallback with `core.fsmonitor=false` was recorded. The package script appended `src tests`, so this was broader than intended. It was stopped after 399.8 seconds (exit 143); no completed suite totals are available. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.573vpq/mail-focused.log.gz`.

## Isolated verification

`mise run test:logged -- --name worker-owner-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` passed unchanged in 59.5 seconds. The matching test-name subset also passed on both this branch and detached origin/main at d7cdfaa8b (2.2 seconds each). No assertions, waits or implementation were changed.

## Hypothesis

The first fake-Git process may exhaust the 200 ms timeout before recording its invocation under load. This is an inference from the missing first call, not a proven root cause. A passing main run does not establish failure independence. Keep this open.


## Merge PR shortcut repair validation — 2026-11-03

`mise run test:logged -- --name repaired-full -- mise run test:full` failed
against committed code at `5962671b5` (1293.4 seconds including 576.4 seconds
waiting for the shared lease). Backend used two file workers. The same test
failed at line 1739 after 308.07 ms: only the fallback Git invocation was
recorded, rather than the initial invocation followed by the fallback.
Evidence: `output/agent-testing/merge-pr-fix-validation/repaired-full.log.gz`.

The unchanged complete owner passed alone in 42.2 seconds:
`mise run test:logged -- --name git-timeout-owner -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures`.
The same complete owner passed in 41.3 seconds on detached `origin/main` at
`bbec5b423`, with independently installed frozen dependencies, using the same
command with `--name target-git-timeout-owner`. Passing logs were deleted by
the logged runner. Passing suite counts were not retained.

The aggregate failure remains unresolved. The target rerun did not reproduce
it, so this observation does not establish a target-branch failure or an
environmental cause. No test assertion, timeout or implementation was changed.
