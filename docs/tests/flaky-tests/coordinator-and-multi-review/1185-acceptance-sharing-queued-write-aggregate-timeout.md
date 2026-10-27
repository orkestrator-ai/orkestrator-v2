# Acceptance sharing queued-write candidate exceeds the aggregate deadline

- **ID:** 1185
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `a queued-write candidate cannot consume the worker commits after its PR merges`
- **Owning file:** `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts`.
- **Change under test:** todo 0052 on branch
  `todo-0052-remote-client-bandwidth-8f94a6e99ef7` (head `a10617ab3`). It
  changes renderer read scheduling, gateway tests, a backend script, docs and
  one comment in `packages/protocol/src/recurring-work.ts`; nothing in
  change tracking.
- **Original command:** `mise run test`, with a host load average of about
  150 on 18 cores, shared with other worktrees' builds.
- **Aggregate result:** backend reported 11,999 passed, 120 skipped and 59
  failed across 12,178 tests in 726 files (1,205.90 s). This case failed after
  23,739.31 ms. It failed again (5 s timeout, 6,365.89 ms) in a
  `--parallel=2` rerun of the 15 backend files that had failed.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts --parallel=1 ./src/core/change-tracking/acceptance-sharing.test.ts`
  passed, 15/15.
- **Evidence:** `orkestrator-test-run.HGGyOM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory.
- **Hypothesis:** its real-Git fixture (worker commits, a merged PR) runs past
  the five-second deadline on a saturated host. Not confirmed. No assertion,
  timeout or skip changed.


## Review-fix validation recurrence — 2026-10-27

At implementation commit `4c70cd01f`, the unchanged owning file failed a
different real-Git fixture in the standard `mise run test` run (two backend
workers, workspace group reservation four slots):
`V09: aliases of one checkout share physical work > V09: environments aliasing
one checkout share one watcher and scan; a linked worktree does not`, reported
at 7015.05 ms. The workspace group had waited 551.9 s for shared host capacity.

The complete unchanged owner passed alone, exit 0 in 6.2 s:

```sh
mise run test:logged -- --name acceptance-sharing-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/acceptance-sharing.test.ts --parallel=1 --only-failures
```

Evidence is under the host temporary directory at
`orkestrator-test-run.9oZXtC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The passing runner removes its log. Contention is a hypothesis; no assertion,
timeout, skip or implementation was changed.


## Permission-rules main-merge recurrence (2026-10-27)

While merging `f7edf57f1bcd6ed52b6b2fb68d4864065198ced7` into
`19b8716087e786bc49512b65aa356c8f85f05b43`, the final
`mise run test:logged -- --name merge-final-default-tests -- mise run test`
run (two backend workers, concurrent workspace/root/bridge/protocol groups)
reported `V09: aliases of one checkout share physical work > V09: environments aliasing one checkout share one watcher and scan; a linked worktree does not` at 7491.98 ms.
The complete owning file then passed alone, exit 0 in 7.0 s:

```sh
mise run test:logged -- --name merge-acceptance-sharing -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/acceptance-sharing.test.ts --parallel=1 --only-failures
```

Aggregate evidence is in
`orkestrator-test-run.QXGTmp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. The aggregate remains non-green; the
passing runner deletes its log. Host contention remains an unconfirmed
hypothesis. No assertion, timeout, skip, or implementation was changed for
this recurrence.

The backend aggregate finished with 12,572 passed, 123 skipped, and 21 failed
across 769 files (630.64 s). Full merge validation and remaining failures are
recorded in [1171](../aggregate-validation-runs/1171-orkestrator-permission-rules-0723-validation.md).
