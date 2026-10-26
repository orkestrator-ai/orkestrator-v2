# Reviewer stale-progress cleanup exceeds the aggregate deadline

- **ID:** 0947
- **Status:** open
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
