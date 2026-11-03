# Preview upstream idle socket close is delayed in aggregate validation

- **ID:** 3101
- **Status:** open
- **Observed:** 2026-11-03
- **Test:** `PreviewUpstreamPool > idle connections expire, and one the application closes is never handed out`
- **File:** `apps/backend/src/preview-upstream-pool.test.ts`
- **Original command:** `mise run test`, at `ced9dbce70ca0cab52b304fb548b58e15af716c2`.
- **Workers:** four backend file workers; concurrent workspace, root and bridge groups.

The case failed after 713.05 ms at line 85: expected `client.destroyed=true`,
received false. Backend totals were 13,378 passed, 99 skipped, two failed;
root totals were 3,451 passed, two failed and one error.
Evidence: `.orkestrator/review-artifacts/review-validation-305987e4-d185-4d3f-bd05-a72e0c7df530/validation-04.stdout.txt`.

The complete unchanged owner passed alone, exit 0 in 0.1 s:

```sh
mise run test:logged -- --name preview-pool-rerun -- bun test --cwd apps/backend ./src/preview-upstream-pool.test.ts --parallel=1 --only-failures
```

Host contention delaying socket-close observation is a hypothesis, not an
established cause. No assertion, timeout, skip or unrelated implementation changed.
