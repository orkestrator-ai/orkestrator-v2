# Desktop backend lifecycle exit-deadline case failed once in an aggregate

- **ID:** 1534
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `desktop backend lifecycle > quits anyway when the backend outlives its exit deadline`
- **File:** `apps/desktop/tests/backend-lifecycle.test.ts:114`
- **Original command:** `mise run test` in
  [0720](../aggregate-validation-runs/0720-mcp-environment-delivery-validation.md),
  on a host also running Docker qualification, image builds and other suites.
- **Failure:** failed at 120.0 ms. The record keeps no assertion message.
- **Isolated rerun:** the owner passed alone, 5 pass, 0 fail.
- **Hypothesis:** none. The case is about a deadline, and 120 ms suggests a
  short test deadline that load can pass; not established. Created on
  2026-10-31 from the 2026-10-25 triage in todo 0030. Next recurrence: keep
  the assertion message and check whether the case uses real time for the
  exit deadline.
