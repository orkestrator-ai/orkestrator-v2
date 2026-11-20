# Reviewer stale-progress cleanup exceeds the aggregate deadline

Current path for the relocated file: `apps/backend/src/core/build-pipeline/review-fanout.test.ts`.

- **ID:** 0947
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `build pipeline multi-model review > abandons running reviewers whose durable progress clock is stale`
- **File:** `apps/backend/src/core/build-pipeline-review-fanout.test.ts`
- **Change under test:** Claude plugin settings consistency; no review-pipeline implementation changed.
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`.
- **Worker configuration:** backend used two workers within a four-slot workspace group; other worktrees also ran validation on this host.
- **Failure:** the five-second test deadline expired (5670.20 ms reported).
- **Evidence:** the host temporary directory's `orkestrator-test-run.j2Vm7f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Aggregate counts:** backend reported 11,437 passes and seven failures across 670 files (700.45 seconds); the other workspace packages passed.
- **Isolated rerun:** `mise run test:logged -- --name review-fanout-isolated -- bun test --cwd apps/backend ./src/core/build-pipeline-review-fanout.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 2.2 seconds).

Concurrent host work stretching asynchronous cleanup is a hypothesis, not a
confirmed cause. No timeout, assertion or skip was changed.

## Resolution (2026-11-15)

- **Class:** default test budget (A). `src/core/build-pipeline-review-fanout.test.ts` sets no budget of its own: no `setDefaultTimeout`, no third-argument or hook timeout, and no wall-clock wait deadline in the test or the helpers it uses. Its `advanceUntil` helper is bounded by a pass count, not by time.
- **Root cause:** the recorded failure was Bun's former 5 s default per-test/hook budget expiring while the host was loaded; the owner passes alone in a few seconds and nothing it asserts depends on elapsed time.
- **Fix:** none in this file. It now runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets the default per-test and hook budget to 60 s as a hang watchdog.
- **Reproduced:** no. Under contention with the old budget forced (`mise run test:logged -- --name a0947 -- bun scripts/test-under-contention.ts --core <n> --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-review-fanout.test.ts --timeout=5000`) the owner passed (39.5 s), so six burners on one core did not recreate the aggregate's load.
- **Stress:** the same contention command with `--rerun-each=3` at the new default passed (96.1 s).
