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
