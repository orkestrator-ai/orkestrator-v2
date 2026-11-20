# Network churn test sometimes loses the stand-in unzip exit status

- **ID:** 10006
- **Status:** open
- **Date observed:** 2026-11-19
- **Test:** `discards the partial output of an oversized read whose unzip still exits 0`
- **File:** `e2e/agent-testing/network-churn-report.test.ts`
- **Branch base:** `fb2c01e830f497e51745bebd8d73a093fb4af90a`
- **Target parent:** `75f4aed74cf4cc9a50859d9deef0bc25b7081593`
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`
- **Worker configuration:** Bun 1.4.4, one worker slot in the root and agent-support group, alongside the other default-tier groups.
- **Failure:** The stand-in process returned `status: null` at the assertion that expects exit status 0. The case took 43.39 ms. The root and agent-support group reported 4,976 passed, two failed and one skipped.
- **Isolated reruns:** `env -u NODE_ENV mise run test:logged -- --name merge-churn-rerun -- bun test ./e2e/agent-testing/network-churn-report.test.ts --parallel=1 --only-failures` reproduced the failure (five passed, one failed). A second isolated run with the same options passed all six tests.
- **Baseline reproduction:** In a detached checkout of the target parent, `bun test --cwd <checkout> ./e2e/agent-testing/network-churn-report.test.ts --parallel=1 --rerun-each=20 --only-failures` through `test:logged` reported 116 passed and four failures with the same status mismatch.

The failure occurs in the fixture's check on the child process before
`networkChurnReport` is called. The stand-in's TERM trap is intended to
produce exit status 0 after the buffer overflows. Whether the child was
signalled and whether the trap ran were not captured. The earlier product
failure in [case 10001](10001-network-churn-partial-unzip-output.md) was a
truncated report being counted after that fixture check.
