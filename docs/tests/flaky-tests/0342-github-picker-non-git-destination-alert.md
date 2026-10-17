# GitHub picker non-git destination alert missing in the root suite

- **ID:** 0342
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `tests/unit/components/GitHubCloneIntegration.test.tsx`.
- **Test:** `GitHub picker to project registration > handles a non-git destination through the real add_project handler`.
- **Original command:** `mise run test` (root and agent-support tests, alongside the workspace and bridge suites).
- **Failure:** `findByRole("alert")` at line 188 gave up after 1706.75 ms with `Unable to find role="alert"`; the Clone from GitHub dialog was still open.
- **Suite result:** 3039 tests across 140 files in 283.75 seconds, one failure.
- **Owning-file rerun:** `bun test --preload ./tests/setup-node.ts tests/unit/components/GitHubCloneIntegration.test.tsx` passed unchanged (7 passed, 0 failed).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nSrOTz/root-and-agent-support-tests.log.gz`.
- **Assessment:** isolated pass confirms intermittence; root cause is unconfirmed. Observed during unrelated backend unread-bell changes. No implementation, assertion, timeout or skip changed.
