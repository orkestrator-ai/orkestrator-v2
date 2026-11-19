# Network churn report counts partial unzip output

- **ID:** 10001
- **Status:** resolved
- **Date observed:** 2026-11-18
- **Test:** `discards partial unzip output when it exceeds the byte bound`
- **File:** `e2e/agent-testing/network-churn-report.test.ts`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test` on `b708f2fce345f5352bcf4a74517baff911600f7d`, with base `8f58386079dce3ba12193f5c3f735c8f7db2cb2d`.
- **Worker configuration:** Bun 1.4.4 with one worker in the root and agent-support group, alongside the other aggregate groups.
- **Failure:** The test expected `null` and received a report with 964 matches after passing a 1,024-byte output bound. The case failed in 101.06 ms. The root and agent-support group reported 4,889 passed, 21 failed and 29 skipped.
- **Isolated rerun:** The aggregate runner invoked `bun test ./e2e/agent-testing/network-churn-report.test.ts --parallel=1`. All five cases passed, including the oversized output case in 86.75 ms.

The report checks the unzip process exit status before parsing stdout. The aggregate failure shows that it parsed output past the requested byte limit. The child process result fields from the failing invocation were unavailable.

## Resolution (2026-11-19)

- **Root cause:** a product bug in `networkChurnReport`
  (`e2e/agent-testing/network-churn-report.ts`). When unzip's output passes
  `maxBuffer`, Bun's `spawnSync` stops the child and returns what it had read
  (about 66 KB here, well past a 1,024-byte bound) with `error` set to
  `ENOBUFS`. The report checked only `status`. Unzip normally reports the stop
  as exit 80, so the case usually passed, but a child that has already
  finished or handles the stop by exiting 0 leaves `status` 0, and the cut
  output was counted. 964 matches of the 69-byte trace line is about 66 KB,
  the size Bun returns from an overflowing read.
- **Reproduced:** yes, as a deterministic regression test,
  `discards the partial output of an oversized read whose unzip still exits 0`:
  a stand-in `unzip` on `PATH` writes 2,000 trace lines and exits 0 when it is
  stopped. A probe of the same stand-in showed `status 0, error ENOBUFS,
  1,035 bytes`, and the new test failed on the unchanged code with
  `oversized: 15`. A probe of the real unzip on macOS and on beelink (alone
  and under `--burners 6`) returned `status 80, error ENOBUFS` in 600 of 600
  reads, so the exit-0 outcome was not caught live.
- **Fix:** the report also discards a read whose `error` is set, which is
  what marks an overflow whatever the exit status.
- **Verified:** `mise run test:logged -- --name f-a-churn -- bun test ./e2e/agent-testing/network-churn-report.test.ts --rerun-each=20`
  passed (exit 0); the same file on beelink (Linux) with `--rerun-each=10`
  passed 60 of 60.

The regression now checks that the stand-in exits 0, reports
`ENOBUFS`, and returns the marker in its partial output before testing the
reporter. The fixture restores an originally absent `PATH` by removing its
override. The owning test file passed with inherited `PATH` and with `PATH`
removed, and `zip` remained discoverable afterward in both runs.
