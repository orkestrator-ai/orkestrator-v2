# `the same write is reported when the whole worktree is watched` misses its delivery deadline on a saturated `fseventsd`

- **ID:** 6613
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `worktree watcher on this platform's real watch > the same write is reported when the whole worktree is watched`
- **File:** `apps/backend/tests/worktree-watcher-real.test.ts`
- **Host:** macOS arm64, Bun 1.4.4, `fseventsd` at 100 to 103% of a core with 17 days of uptime.
- **Original command:** `mise run test:logged -- --name worktree-watcher-real -- bun --cwd=apps/backend test ./tests/worktree-watcher-real.test.ts --preload ../../tests/setup-node.ts --parallel=1 --timeout=900000`, one worker, on the environment deletion branch at `a8ded1c7a`, whose helper process carries this file's watches on macOS.
- **Failure:** the test timed out at 180,046.80 ms, its budget of two 90 s delivery deadlines. An unhandled error followed between tests: `no change noticed in node_modules/pkg-1/lib`, from `expectNoticed`, which was still running.
- **Suite counts:** 14 passed, 1 skipped, 1 failed, 1 error, 16 tests in 1,053.53 s. Evidence: `orkestrator-test-run.NgcKtU/worktree-watcher-real.log.gz` under the host temporary directory.
- **Isolated rerun:** the same command with `--test-name-pattern "the same write is reported"` passed in 85.8 s.
- **Assessment:** the whole file ran alone, and the case failed and then passed alone, so the load came from outside the file. Other tests in the failing run needed up to 581 repeated writes before their first notice, which at 150 ms per write is close to the 90 s deadline. `removing the ignore rule makes node_modules visible again` needs the same `node_modules` event path and passed in that run, so the path itself works. Separate probes on this host saw independent Bun and Node processes get a first event 72 s in and about 44 events for the first 107 files, which fits [5061](5061-real-git-owner-saturated-fseventsd.md). A delivery slower than the deadline is the likeliest cause, but this run did not measure that write's own latency. The assertion and deadlines were left unchanged.
