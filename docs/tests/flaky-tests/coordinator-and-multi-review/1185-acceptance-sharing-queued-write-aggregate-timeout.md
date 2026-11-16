# Acceptance sharing queued-write candidate exceeds the aggregate deadline

- **ID:** 1185
- **Status:** resolved
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


## Storage-maintenance review fixes recurrence (2026-10-27)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) timed out in `V09: aliases of one checkout share physical work > V09:
environments aliasing one checkout share one watcher and scan; a linked worktree
does not` after 8876.12 ms against its 5000 ms deadline. The host load average
was subsequently observed at 138.87.

The complete unchanged owner passed alone (15 tests, exit 0, 8.9 s):

```sh
mise run test:logged -- --name acceptance-sharing-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/acceptance-sharing.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory in
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The aggregate remains non-green. Contention is a hypothesis, not an established
cause; the owner and its deadlines were unchanged.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.


## Main CI recurrence — 2026-11-11 (V09 count, not deadline)

Observed 2026-11-11 in `main` CI run 43093113394 (job "Tests (backend)",
head `963ffa6ab`, PR #2176, agent-testing specs only). Recorded from branch
`fix-ci-main-1727044b99e3-r1`, base `51456e887`
(`mise run flaky:recurrence -- 1185 --base 51456e887` answered "open").

`V09: aliases of one checkout share physical work > V09: environments aliasing
one checkout share one watcher and scan; a linked worktree does not` failed
in 89.27 ms, not at a deadline: `expect(shared.executed).toBeLessThanOrEqual(2)`
received 3. `SharedScanQueue.run` joins a request only while a pass is
running or queued, so three passes run when the first finishes before a
later alias's request reaches it. That ordering depends on how fast the three
`track()` calls reach the queue, which a loaded runner does not bound — the
same contention family as the deadline failures above.

- **Command:** `mise run test:full` with `ORKESTRATOR_TEST_GROUPS=backend`
  (two backend workers) on the GitHub-hosted Linux x64 runner.
- **Isolated rerun:** the runner's automatic rerun never ran the file (the
  `::group::` path bug fixed in the same change, see case 9963's recurrence).
  Locally, `bun test --preload ../../tests/setup-node.ts src/core/change-tracking/acceptance-sharing.test.ts`
  in `apps/backend` passed 15/15 three times.

Status stays open. Making V09 deterministic would hold the first scan until
every alias has requested one; no assertion, timeout or skip changed here.

## Resolution (2026-11-15)

- **Class:** the test, in two parts.
- **Root cause:**
  1. *Deadlines.* `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` set `setDefaultTimeout(30_000)` and its `until` helper threw `condition not reached` after 3 s (15 s in V09), so a slow real-Git fixture failed the file for time alone.
  2. *Join count (V09, 2026-11-11, `toBeLessThanOrEqual(2)` received 3).* The three aliases do not all reach the shared scan queue together: `env-a` and `env-c` resolve to the same admission target (`local:<repo>`, one at a time), so `env-c` asks for its pass only after `env-a`'s pass has finished. Whether it joined the second pass then depended on that pass still running, and on `requestedAt` being strictly earlier than that pass's start in whole milliseconds, which a loaded runner does not bound.
- **Fix:** V09 now holds each of the first two physical passes behind a deferred until the requests that must meet it have reached the queue (env-b meets pass one, env-c meets pass two), and lets one clock millisecond pass before releasing, so the join outcome (`executed` 2, `joined` 1) no longer depends on timing. `until` keeps no deadline of its own, and `setDefaultTimeout(30_000)` is removed so the file inherits `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets Bun's default per-test and hook budget to 60 s. Assertions unchanged.
- **Reproduced:** no. The unchanged V09 test passed 30 of 30 reruns (`--rerun-each=30`, six burners on core 14), so neither the 3-executed outcome nor the deadline was observed here; the cause for the count is derived from `SharedScanQueue.run` and the admission pool's one-per-target rule, and the first attempt at gating (all three requests) deadlocked until the budget for exactly that reason.
- **Verified after the fix:** the complete owner passed alone (1.3 s) and `--core 14 --burners 6 --rerun-each=5` (44.3 s).
