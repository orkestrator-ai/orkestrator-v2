# enterPrivateTestTmpdir removes a directory an outliving process still names

- **ID:** 3120
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause (test setup race):** the child spawned the detached "browser" and called `leave()` at once. Teardown (`removePrivateTmpdir`, then `namedByLiveProcess`) reads every `/proc/<pid>/cmdline` on Linux. Nothing ensured that the grandchild was observable with its own argv by then. `spawn` returns once the pid exists; until the grandchild's `execve` has set up its new argument area, its `cmdline` is the parent's argv or empty. Neither names the directory, so the scan missed it and the directory was removed. On a busy 4-core runner the grandchild can be descheduled in that window. This matches the hypothesis already recorded here.
- **Reproduced:** no. The window lies inside the kernel's exec path and could not be widened from the test without changing what is being tested.
- **Fix (test only, `tests/unit/private-tmpdir.test.ts`):** the grandchild writes a `browser-ready` file (path passed in `ORK_TEST_BROWSER_READY`) as its first statement, which runs only after exec. The child polls for that file, bounded at 10 s, before `leave()` and reports `browserReady`, and the test asserts it. The retention assertions are unchanged. This matches the real case, a browser that is already running when teardown happens.
- **Verification:** `mise run test:logged -- --name ptmp-stress -- bun test tests/unit/private-tmpdir.test.ts --rerun-each=20 --parallel=2` PASS (12.5 s, exit 0). No grandchild process remained afterwards.
