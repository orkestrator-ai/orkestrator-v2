# Storage backup descendants remain visible after abrupt backend death

- **ID:** 1317
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `database snapshots > abrupt backend death terminates the supervisor and its blocked copy before restart cleanup`
- **File:** `apps/backend/src/core/storage-backups.test.ts:401`
- **Original command:** `mise run test` during pipeline validation-history review preparation.
- **Failure:** `descendants.some(alive)` was true instead of false after the bounded exit wait (2484.04 ms). Backend totals were 11,266 passed, 87 skipped and two failed across 775 files (437.48 s).
- **Preparation evidence:** `.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`.

The complete unchanged owner passed alone with exit 0 in 3.0 s:

```sh
mise run test:logged -- --name recorded-backend-backups -- bun test --cwd apps/backend ./src/core/storage-backups.test.ts --parallel=1 --only-failures
```

The logged runner removed passing output and retained its summary in
`orkestrator-test-run.qgBIcT` below the host temporary directory. Delayed
descendant exit or observation under shared-host load is a hypothesis, not a
confirmed cause. No storage implementation, assertion, timeout or skip changed.
