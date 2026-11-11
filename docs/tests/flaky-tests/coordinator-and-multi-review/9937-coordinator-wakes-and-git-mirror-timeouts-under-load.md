# Coordinator wake and git-mirror tests time out at 5 s under host load

- **ID:** 9937
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
