# Loopback wrapper's SIGHUP child never prints "forwarded" under load (`tests/unit/loopback-network.test.ts`)

- **ID:** 9943
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e`.
- **Observed head:** branch `remove-dead-bridge-be98778b92d1-r1` at
  `b043def44` plus uncommitted test fixes (7571 removals of the bridge SSE
  mode, Claude tombstones and old renderer readers). It does not touch
  `scripts/loopback-network.ts` or `tests/unit/loopback-network.test.ts`.
- **Test:** `loopback wrapper failure and signal paths > forwards and re-raises SIGHUP`
  (`tests/unit/loopback-network.test.ts:212`). The SIGINT and SIGTERM cases
  of the same loop passed in the same run.
- **Failure:** `expect(output).toContain("forwarded")` received `"ready\n"`
  after 32.57 ms. The child had printed `ready`, so its
  `process.on("SIGHUP")` handler was installed before the test signalled the
  wrapper, yet its `forwarded` line never reached the test's stdout pipe
  before the wrapper exited.
- **Original command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  on Linux, with other worktrees' aggregate suites holding most of the host's
  16 test slots. The root and agent-support group reported 4432 pass, 1 skip
  and 75 fail across 254 files; the other 74 failures were
  `ClaudeTmuxChatTab.parts.test.tsx`, caused by the branch and fixed in it.
  The runner's own alone-rerun of this file queued for host capacity and was
  cut off by the 1800 s group deadline.
- **Isolated rerun:** `mise run test:logged -- --name loopback-network -- bun test tests/unit/loopback-network.test.ts --parallel=1 --only-failures`
  passed unchanged in 0.7 s.
- **Evidence:** `orkestrator-test-run.QbQy1r/review-default-tests-rerun.log.gz`
  under the host temporary directory.

## Hypothesis

Not established. The symptom resembles
[9945](9945-test-tiers-sighup-wrapper-exit-129.md): a forwarded SIGHUP under
load ends the child without its handler's output or exit status being seen.
Either the signal reaches the child while Bun's runtime rather than the
handler owns SIGHUP, or the handler's `console.log` is lost when it re-raises
the signal straight away. Treat it as a possible signal-forwarding race before
raising any budget. No assertion, timeout or skip was changed.
