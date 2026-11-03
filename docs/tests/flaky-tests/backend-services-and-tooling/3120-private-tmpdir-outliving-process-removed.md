# enterPrivateTestTmpdir removes a directory an outliving process still names

- **ID:** 3120
- **Status:** open
- **Date observed:** 2026-11-03 (GitHub Actions CI run 41607725738, `main` at `b88623136`)
- **Test:** `enterPrivateTestTmpdir > retains its own directory while an outliving process names it`
- **File:** `tests/unit/private-tmpdir.test.ts`
- **Original command:** the "Tests (root-bridges)" shard of `mise run test:full` on
  `ubuntu-latest`, with the other shards on separate runners.
- **Failure:** line 214, `expect(result.removed).toBe(false)` received `true`
  after 29.06 ms. The other root-bridges failures in that run were two
  guard tests fixed on the same branch as this record.
- **Owning-file rerun:** `mise run test:logged -- --name ptmp-N -- bun test tests/unit/private-tmpdir.test.ts --parallel=1 --only-failures`
  passed three times in a row on macOS (0.5 s each). The PR runs of the same
  morning (for example 41605456464) passed this case on Linux.
- **Evidence:** the CI job log of run 41607725738, job 125821636041.

Hypothesis, not established: the child spawns a detached process and exits at
once. Teardown scans the process table for a command line naming the
directory; on Linux a freshly forked child can still show the parent's
command line until it execs, so the scan can miss it and teardown removes the
directory. No assertion, timeout, skip or implementation was changed.
