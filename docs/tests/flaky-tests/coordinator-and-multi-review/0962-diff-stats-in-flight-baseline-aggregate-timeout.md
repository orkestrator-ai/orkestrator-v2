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


## Storage-maintenance review fixes observation (2026-10-27–28)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) timed out in `a worker that takes in newer target history is retargeted
to where its branch now leaves it` after 7590.15 ms against its 5000 ms deadline.

The complete unchanged owner did not pass alone:

```sh
mise run test:logged -- --name diff-tracking-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/diff-stats-tracking.test.ts --parallel=1 --only-failures
```

It reported 19 passed, 2 failed and 2 between-test errors across 21 tests
(55.33 s). The runtime-isolation case exceeded a hook deadline at 13066.21 ms,
and the newer-target-history case exceeded a hook deadline at 15199.44 ms;
the errors involved a removed Git fixture and a Git child terminated by SIGTERM.
This observation does not establish an aggregate-only flake. The file and its
implementation were unchanged. Evidence is under the host temporary directory:
`orkestrator-test-run.V5WZYj/diff-tracking-owner.log.gz` and
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.
