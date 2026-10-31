# Application logging shutdown failed once in an aggregate

- **ID:** 1533
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `application logging shutdown > holds the quit open until the flush completes, then quits once`
- **File:** `apps/desktop/electron/application-logging.test.ts:406`
- **Original command:** `mise run test` in
  [0720](../aggregate-validation-runs/0720-mcp-environment-delivery-validation.md),
  on a host also running Docker qualification, image builds and other suites.
- **Failure:** failed at 73.4 ms. The record keeps no assertion message.
- **Isolated rerun:** the owner passed alone, 25 pass, 0 fail.
- **Hypothesis:** none; 0720 classed its run as environmental and noted "the
  two desktop shutdown cases have no earlier case". Created on 2026-10-31 from
  the 2026-10-25 triage in todo 0030. Next recurrence: keep the assertion
  message; a 73 ms failure is not a deadline, so it is more likely an ordering
  assumption than load.
