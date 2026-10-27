# Diff-stats in-flight baseline fence exceeds the aggregate deadline

- **ID:** 0962
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `an in-flight baseline is fenced after prBaseBranch changes`
- **Owning file:** `apps/backend/src/core/diff-stats-tracking.test.ts`.
- **Change under test:** todo 0035 on branch
  `todo-0035-mobile-layout-gaps-49509c5f9933` (head `aaea46d6a`). It changes only
  renderer code (`apps/web`), browser specs and docs, not the backend.
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`,
  with host load averages of 38 to 44 on 18 cores, shared with other worktrees'
  runs.
- **Aggregate result:** backend reported 11,763 passed, 97 skipped and 3 failed
  across 11,863 tests in 703 files (747.32 s). This case failed after
  6243.56 ms. Just before it, the file logged "killed 1 dangling process" and an
  unhandled `CommandFailedError: fatal: the remote end hung up unexpectedly`
  (`signal: "SIGTERM"`, `timedOut: false`) from `runCommandBytes` in
  `apps/backend/src/core/shell.ts`. The other two failures were recurrences of
  [0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md)
  and [0189](0189-looped-review-scheduling-timeout.md).
- **Isolated rerun:** `mise run test:logged -- --name diff-stats-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/diff-stats-tracking.test.ts --parallel=1 --only-failures`
  passed, exit 0 (11.4 s).
- **Evidence:** `orkestrator-test-run.xIhDQt/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory.
- **Hypothesis:** the real-Git baseline fixture ran past the test's deadline on
  a saturated host, and the Git child it started was killed with SIGTERM
  when the test ended, which produced the unhandled error. This is not
  confirmed. No assertion, timeout or skip changed.


## Remote-bandwidth validation recurrence — 2026-10-27

Branch `todo-0052-remote-client-bandwidth-8f94a6e99ef7`, implementation
commit `4c70cd01f`, leaves this owning file and its implementation unchanged.
`mise run test:logged -- --name tests -- mise run test` used the standard
workspace/root/bridges/protocol reservations (4/1/2/1, two backend workers).
The workspace group waited 551.9 s for shared host capacity.

The same owner reported two other real-Git fixture deadlines:

- `a worker that takes in newer target history is retargeted to where its
  branch now leaves it`: five-second test deadline, reported at 8035.20 ms.
- `a cached candidate cannot consume the worker commits after its PR merges`:
  before/after hook deadline, reported at 9302.12 ms.

The unchanged complete owner passed alone (exit 0, 20.8 s):

```sh
mise run test:logged -- --name diff-stats-isolated -- bun test --cwd apps/backend ./src/core/diff-stats-tracking.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory at
`orkestrator-test-run.9oZXtC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The passing runner removes its log. Host contention is a hypothesis for these
fixture deadlines, not a confirmed shared cause with the original baseline
fence failure. No assertion, timeout, skip or product implementation changed.
