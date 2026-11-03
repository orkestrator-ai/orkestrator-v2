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

## 2026-11-03 checkout-follow review

Preparation at d41f4b97295de8a68ec532d5c820aa5e00d8a130 ran
`mise run test:all`; the backend group reported 16,591 pass, 201 skip and
4 fail. The Node variant failed after 438.22 ms: only the fsmonitor-disabled
fallback was recorded, rather than both Git calls. The preparation evidence is
`.orkestrator/review-artifacts/review-validation-937ee3a0-154a-401f-ba6a-7fa0eff0fae1/validation-04.stdout.txt`.

The unchanged complete owner passed with
`mise run test:logged -- --name fix-status-timeout-owner -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures`
(exit 0, 42.0 s). Detached origin/main at 5fc5982aa also passed the owner in a
three-file, one-worker run (126 pass, 2 unrelated failures overall); 30 repetitions
of both timeout variants passed there in 17.5 s. This confirms timing sensitivity
but does not reproduce the failure on main; its independence remains unproven.
No timeout or assertion was loosened.
