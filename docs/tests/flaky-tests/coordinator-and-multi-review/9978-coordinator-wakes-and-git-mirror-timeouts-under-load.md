# Coordinator wake and git-mirror tests time out at 5 s under host load

- **ID:** 9978
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`.
- **Observed head:** `4d294fd07` on branch
  `preview-service-discovery-6ba3314b7f90-r1`. The branch changes only
  documentation, the headless Electron spec list and its unit test, and
  comments in two preview test files; it touches none of the owning files or
  anything they import.
- **Files and tests (one aggregate run, 11 failures, each at the 5,000 ms
  default timeout):**
  - `apps/backend/src/core/coordinator-pr-remote.test.ts`: `a remote worker's
    conflicts get one Resolve tab, and its PR is followed through the node link`
  - `apps/backend/src/core/coordinator-status-wakes-pr.test.ts`: six cases of
    `pull request status wakes > …`, including `a PR wakes once per state
    change until merge (hidden: %s)` (twice)
  - `apps/backend/src/core/coordinator-worker-outcomes.test.ts`: `worker
    outcome wakes > Merge and Cleanup on a pipeline's worker is one notice
    naming both`, `worker outcome wakes > first observation reports an
    immediate closed outcome`
  - `apps/backend/tests/project-git-mirror-create.test.ts`: `mirror mount
    respects policy 2 port semantics`, `mirror mount respects policy 3 port
    semantics`
- **Original command:**
  `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  on Linux x86_64 (Bun 1.4.4). The guard stage was skipped because of an
  unrelated baseline finding in `ServiceBrowserTab.test.tsx`. Backend group:
  18,358 pass, 11 fail, 18,519 tests across 1,276 files (187.0 s). Every
  other group passed. Another worktree held an exclusive scheduler resource
  (8/16 slots reserved) during the run, and the runner's own rerun of
  `coordinator-pr-remote.test.ts` waited for capacity and then hit its 600 s
  budget with no verdict.
- **Isolated reruns:**
  `mise run test:logged -- --name rerun-<file> -- bun --cwd=apps/backend test <path> --parallel=1 --only-failures`
  - `coordinator-pr-remote`: passed (2.6 s)
  - `coordinator-worker-outcomes`: passed (5.3 s)
  - `project-git-mirror-create`: passed (4.4 s)
  - `coordinator-status-wakes-pr`: the first solo run failed one case (`a PR
    wakes once per state change until merge (hidden: %s)`, 5,004 ms timeout;
    15 pass, 1 fail, 23.7 s). A second solo run passed all 16 (12.2 s).
- **Evidence:** `orkestrator-test-run.bI5w1R/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `orkestrator-test-run.shMMP5/rerun-coordinator-status-wakes-pr.log.gz`
  under the host temporary directory.

## Observations

The failing solo run of `coordinator-status-wakes-pr` logged
`[coordinator] wake.worker-outcomes-failed` with a `TypeError`:
`this.host.storage.coordinators.updateCoordinatorWorkflowAssociations is not
a function`, from `reconcile` in `coordinator-worker-outcomes.ts:260`. The
aggregate backend log has the same line once. The production storage area
defines the method (`storage-coordinators.ts`), so the host that test builds
appears to hand the reconciler a storage object without it on some path.
Whether that error is what leaves the awaited wake unsent, or just
accompanies a slow run, is not established.

## Hypothesis

These tests await a wake or mount driven by real timers and background
reconcile loops, and the 5 s default leaves little margin on a loaded host.
The `TypeError` above may be a second cause for the status-wakes case: if a
reconcile pass throws on a storage fake missing the method, the wake that pass
would have sent depends on a later pass arriving within the budget. Per the
testing guide, reproduce first (for example by stressing the file with
`--rerun-each` under CPU load, and by checking which storage the test's host
passes to the worker-outcome reconciler) before changing a budget or the
fixture.

## Recurrence — 2026-11-11 (backend domain restructure review repairs)

Observed 2026-11-11 on `backend-domain-restructure-13639d788e59-r1` at
`98f77e1d0`, base `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9978 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch fixes `scripts/move-backend-modules.ts`
and moves the `core/web-annotation-*` modules into `core/web-annotations/`;
none of the four owning files imports a web-annotation module directly.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (Linux x86_64, Bun 1.4.4). Another worktree held an exclusive scheduler
  resource and the host reported 14 to 16 of 16 slots reserved; the 15-minute
  load average was about 45 on 16 cores when the run ended.
- **Failure:** 21 backend cases, each at the 5,000 ms default timeout:
  `coordinator-status-wakes-pr.test.ts` 11, `coordinator-worker-outcomes.test.ts` 7,
  `project-git-mirror-create.test.ts` 2 (`mirror mount respects policy 2/3
  port semantics`), `coordinator-pr-remote.test.ts` 1. The
  `updateCoordinatorWorkflowAssociations is not a function` line appeared once
  in the backend log again.
- **Suite counts:** backend 18,552 pass, 153 skip, 21 fail, 2 errors (18,726
  tests across 1,291 files, 404.9 s). The root, bridge and lockfile groups
  passed. The runner's own solo rerun of `coordinator-status-wakes-pr` waited
  435 s for capacity and was cut off by the 1,800 s group deadline.
- **Isolated reruns** (`NODE_ENV=test bun test --preload ../../tests/setup-node.ts <path> --parallel=1`
  from `apps/backend`, through `test:logged`): all four passed
  (`coordinator-pr-remote` 3.4 s, `coordinator-status-wakes-pr` 9.4 s,
  `coordinator-worker-outcomes` 2.9 s, `project-git-mirror-create` 1.0 s).

Status stays open; no assertion, timeout or skip changed.
