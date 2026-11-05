# ActionBar script launch activation recurrence

- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `ActionBar editor and run commands > activates an unknown script launch but skips activation when launch throws`
- **File:** `apps/web/src/components/layout/ActionBar.test.tsx:2205`

Preparation at `a89e2e827` ran `mise run test` with package-configured parallel
workers and found one activation call where zero were expected (424.74 ms).
Original evidence: `.orkestrator/review-artifacts/review-validation-81b1b0a7-2350-4eb7-aacc-cbbe84a9b965/validation-04.stdout.txt`.
Consolidated counts: 31,356 pass / 143 skipped / 4 failures.

The complete unchanged owner passed with
`NODE_ENV=test mise run test:logged -- --name address-actionbar-test-env -- bun --no-env-file test --cwd apps/web src/components/layout/ActionBar.test.tsx --parallel=1 --only-failures`
(exit 0, 39.3 s). An earlier focused invocation inherited `NODE_ENV=production`
and failed 309 cases because React.act was absent; evidence:
`/tmp/orkestrator-test-run.MxXud3/address-actionbar.log.gz`.

The isolated pass establishes intermittence; the activation race's cause remains
unconfirmed. Preparation marks this related by an import of Docker getters;
no activation implementation, assertion, wait or skip was changed here.
