# Network churn test sometimes loses the stand-in unzip exit status

- **ID:** 10006
- **Status:** resolved
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

## Recurrence (2026-11-23)

- **Branch base:** `ce2aabba08f9588a7cd5d5f035d964d059e1b303`
- **Target parent:** `5239d8a334bcc51828a347b9176c8779197f41e9`
- **Command:** `mise run test` after a frozen dependency install. Bun 1.4.4 ran the root and agent-support group with one worker slot alongside the other default-tier groups.
- **Failure:** The stand-in returned `status: null` where the test expected exit status 0 at line 103. The case took 7.73 ms. The group reported 5,053 passed, one failed and one skipped.
- **Isolated rerun:** `env -u NODE_ENV mise run test:logged -- --name merge-network-churn-rerun -- bun test ./e2e/agent-testing/network-churn-report.test.ts --parallel=1 --only-failures` passed. The failure again occurred in the fixture before the report assertion.

## Resolution (2026-11-25)

- **Root cause:** the overflow closes the read end of the stand-in's pipe as
  well as sending TERM. A `printf` that reached the closed pipe first killed the
  stand-in with SIGPIPE, so `spawnSync` returned `status: null`,
  `signal: "SIGPIPE"`.
- **Fix:** the stand-in in `e2e/agent-testing/network-churn-report.test.ts`
  ignores SIGPIPE, discards the write errors and exits 0 after its loop. No
  assertion and no product code changed.
- **Reproduced:** yes. The same script called 400 times with `maxBuffer: 1024`
  (Bun 1.4.4, Linux) ended `null/SIGPIPE` 12 times; the changed script ended
  `0/ENOBUFS` 2,000 of 2,000 times.
- **Stress:** `bun test ./e2e/agent-testing/network-churn-report.test.ts --parallel=1 --rerun-each=300 --only-failures`
  passed 1,800 of 1,800.
