# Network churn report counts partial unzip output

- **ID:** 10001
- **Status:** open
- **Date observed:** 2026-11-18
- **Test:** `discards partial unzip output when it exceeds the byte bound`
- **File:** `e2e/agent-testing/network-churn-report.test.ts`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` on `b708f2fce345f5352bcf4a74517baff911600f7d`, with base `8f58386079dce3ba12193f5c3f735c8f7db2cb2d`.
- **Worker configuration:** Bun 1.4.4 with one worker in the root and agent-support group, alongside the other aggregate groups.
- **Failure:** The test expected `null` and received a report with 964 matches after passing a 1,024-byte output bound. The case failed in 101.06 ms. The root and agent-support group reported 4,889 passed, 21 failed and 29 skipped.
- **Isolated rerun:** The aggregate runner invoked `bun test ./e2e/agent-testing/network-churn-report.test.ts --parallel=1`. All five cases passed, including the oversized output case in 86.75 ms.

The report checks the unzip process exit status before parsing stdout. The aggregate failure shows that it parsed output past the requested byte limit. The child process result fields from the failing invocation were unavailable.
