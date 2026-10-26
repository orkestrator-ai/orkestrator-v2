# Service preview rollout (0042) validation

- **ID:** 0942
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0042 on branch
  `todo-0042-service-preview-rollout-f64ae24ade8a` (head `59157d460` for the
  second run): desktop preview partition retention for nodes, tunnel
  liveness client pings, legacy URL tab navigation basis, "Open as service",
  the browser toolbar, Electron and private-origin specs, `disk:report`.
- **Original command:** `mise run test:logged -- --name full-tests-0042-2 -- mise run test`,
  host load average 38 to 48 on 18 cores, shared with other worktrees' runs.
- **Aggregate result:** failed after 1653.8 s with only the workspace group
  failing (root, bridges and the Codex protocol lockfile passed). Five
  backend failures, all in files the change does not touch:
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery
    re-links submodules of an adopted or abandoned copy` (5115.78 ms; see
    [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)).
  - `apps/backend/src/core/multi-review-service.test.ts`: `native follow-up
    invalidates interactive PR authorization at restart` (6951.05 ms).
  - `apps/backend/src/core/diff-baseline.test.ts`: `a rebase excludes
    imported history and retains the rebased worker commits` (5749.65 ms).
  - `apps/backend/src/core/path-safety.test.ts`: `writeConfinedFile > rejects
    a symlinked ancestor and a regular file standing in for one` (5036.30 ms).
  - `apps/backend/tests/standalone-ready.test.ts`: `escalates SIGTERM to
    SIGKILL after the grace period` (SIGKILL arrived inside the 30 ms grace;
    see [0491](../backend-services-and-tooling/0491-standalone-ready-sigkill-escalation-aggregate.md)).
- **Owning-file reruns** (`bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./<file> --parallel=1` through `test:logged`):
  multi-review-service, diff-baseline, path-safety and standalone-ready
  passed at once. environment-move failed its first rerun at load 48
  (`moves a worktree with nested submodules (copy)` 5115.59 ms, see
  [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), and the restart
  recovery case again, 5045.19 ms) and passed the second (50.2 s).
- **First full run** (`full-tests-0042`, 1768.1 s, before the final commit)
  failed only on two real defects in the change, both fixed before the second
  run: a DOM query passed to `toBeNull` in `ServiceBrowserTab.test.tsx`
  (`tests/unit/test-diagnostic-bounds.test.ts`) and the moved toolbar classes
  (`tests/unit/mobile-responsive-contracts.test.ts`).
- **Evidence:** `orkestrator-test-run.rWSvnE/` and `orkestrator-test-run.TejCY1/`
  below the host temporary directory.
- **Assessment:** five-second budgets and a 30 ms kill grace missed on a
  saturated host. No assertion, timeout or skip changed.

## After rebasing onto `26b51f144` — 2026-10-25

`mise run test:logged -- --name full-tests-0042-3 -- mise run test` on head
`7780c6934` (load about 46): root, bridges and the Codex protocol lockfile passed;
the workspace group failed on two backend timeouts in untouched files:
`apps/backend/src/core/terminal-history.test.ts` `terminal history >
normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
(5001.13 ms, see
[0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md))
and the environment-move restart recovery case again (5043.62 ms, 0248).
Both unchanged owners passed alone (7.7 s and 29.1 s). Evidence:
`orkestrator-test-run.UFTXLR/` below the host temporary directory.


## Review-fix follow-up — 2026-10-25

The follow-up addresses handover retention admission/source selection, delayed
legacy conversion, refresh confirmation, host-socket matching and compatibility
navigation. Validation started from `4ffb776ba` with these changes uncommitted.

- `mise run test:logged -- --name repository-final -- mise run test` used the
  aggregate's workspace/root/bridge/protocol reservations of 4/1/2/1. The root
  group caught a new DOM `toBeNull` assertion in the added conversion test; it
  was corrected to the bounded boolean absence assertion. The complete root
  and agent-support group then passed through `test:logged` (`root-final`,
  `--parallel=4`, 37.8 s), and the owning diagnostic guard passed (2.7 s).
- The same aggregate observed `local preview service discovery on this host >
  two environments, a restart on the reused port, and an auto-incremented port`
  in `apps/backend/src/core/preview-local-discovery.test.ts:572` failing after
  421.57 ms. The synthetic child server hit `EADDRINUSE` on `127.0.0.1:60379`
  and its terminal exited before reporting a bound port. The complete unchanged
  owning file passed alone in 4.5 s with
  `mise run test:logged -- --name discovery-recheck -- bun test --cwd apps/backend ./src/core/preview-local-discovery.test.ts --parallel=1 --only-failures`.
  Reserving then releasing an ephemeral port, and assuming its adjacent port is
  free, can race with other listeners on the shared host; this is an
  evidence-backed hypothesis, not a demonstrated implementation failure. No
  timeout, assertion or skip was changed in that file. The aggregate finished
  after 672.7 s: all workspace packages except backend passed (web 9,816;
  desktop 1,297; protocol 1,879; CLI 288; toolchain 91; public web 41). Backend
  reported 11,586 passed, 89 skipped and this one failure. Bridges and the Codex
  protocol lockfile passed; the original root diagnostics failure was corrected
  and its complete group rerun passed as described above.
- `mise run test:agent:browser:isolated` used disposable profile
  `qa-browser-a2afe06b-8e2`: 35 passed, 65 skipped, one failed in 7.9 minutes.
  `e2e/agent-testing/web-annotations-gateway.spec.ts:650` expects the old
  `<requestId>-<digest>.png` evidence filename, while the existing
  `materializedEvidencePath` hashes the complete request ID. Both the assertion
  and the hashing implementation are unchanged from `4ffb776ba`. This is a
  reproducible existing test-contract mismatch, **not a flake**.
- The complete unchanged browser owner was rerun with one worker in fresh
  disposable profile `qa-preview-review-1025-f64`:
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-preview-review-1025-f64 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-preview-review-1025-f64 mise run test:logged -- --name annotation-browser-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/web-annotations-gateway.spec.ts --workers=1`.
  It reproduced the same mismatch: four passed, seven skipped, one failed in
  27.5 s. Both profiles were stopped and reset using their exact names.
- Focused preview component/store/matcher tests, desktop retention and real-node
  handover tests, and `mise run check` passed. The full Electron suite passed
  all 39 tests in 316.5 s. The review-fix code did not change annotation
  materialization or the failing browser expectation.
- Evidence: aggregate group logs under temporary directory
  `orkestrator-test-run.X3AhZ1/`, outer aggregate log under
  `orkestrator-test-run.XLKgRr/`, and browser-owner failure log under
  `orkestrator-test-run.zx2Iex/`. Browser screenshots, error context and traces
  are under `output/agent-testing/qa-browser-a2afe06b-8e2/browser/` and
  `output/agent-testing/qa-preview-review-1025-f64/browser/`.

- `mise run test:logged -- --name component-browser -- mise run test:browser`
  completed its Chromium component portion with 741 passed, 102 skipped and
  three failed in 7.5 minutes (nine workers). The BrowserTab toolbar spec still
  expected a single row at 480 px although the existing contract wraps below
  672 px. The spec now checks a wrapped 480 px row and an unwrapped 720 px row;
  its complete owner passed (two passed, two project skips, 11.1 s logged):
  `ORKESTRATOR_E2E_PORT=63101 mise run test:logged -- --name browser-toolbar-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/BrowserTab.spec.ts --workers=1 --output output/playwright/review-toolbar-owner`.
- The other two component failures were the known native Chrome branch picker:
  both projects of `e2e/AgentLaunchDialog.spec.ts:7` retained `rel` instead of
  selecting `release/2.0`. The complete unchanged owner reproduced both
  failures (two passed, two failed, 76.5 s logged) with
  `ORKESTRATOR_E2E_PORT=63102 mise run test:logged -- --name branch-picker-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output output/playwright/review-branch-owner`.
  This matches the base-commit failures recorded in
  [0825](0825-dependency-upgrades-0032-validation.md), rather than establishing a
  new flake. Component evidence is in temporary
  `orkestrator-test-run.hsPReK/`, native-picker owner evidence in
  `orkestrator-test-run.ZFdFk7/`. The public-site browser command did not run
  because the preceding component command failed.

## Storage repository main merge — 2026-10-25

- **Merge parents:** `369d22489` and `f47398fdc`. The conflict resolution
  forwards coordinator background-work timeout metadata through the storage
  facade and repository, and adapts the startup-prompt environment lookup to
  the project repository. It does not edit preview discovery or its test owner.
- **Command:** `mise run test:logged -- --name merge-main-tests -- mise run test`,
  with workspace/root/bridges/protocol reservations of 4/1/2/1 and two backend
  workers. Root, bridges, protocol regeneration and every workspace package
  except backend passed. Backend reported 11,611 passed, 91 skipped and one
  failed across 11,703 tests in 695 files (422.41 s); the workspace group
  finished in 495.1 s.
- **Failure:** `local preview service discovery on this host > two environments,
  a restart on the reused port, and an auto-incremented port` in
  `apps/backend/src/core/preview-local-discovery.test.ts:617` (696.68 ms).
  After registering the second server's incremented port, the endpoint was
  available but its ownership was `user-registered` and listener `unattributed`,
  where the test expected `managed-process`.
- **Complete unchanged owner reruns:**
  `mise run test:logged -- --name merge-main-preview-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-local-discovery.test.ts --parallel=1 --only-failures`
  failed during the aggregate (18 passed, one failed, 3.91 s): the synthetic
  server hit `EADDRINUSE` on `127.0.0.1:62651` and its terminal exited before
  reporting a bound port. The same command with name
  `merge-main-preview-post-suite`, after the aggregate finished, failed again
  (18 passed, one failed, 3.46 s), with `EADDRINUSE` on `127.0.0.1:49540`.
- **Evidence:** aggregate group logs in `orkestrator-test-run.BJhYag/`, outer
  log in `orkestrator-test-run.jUkCFn/`, and owner reruns in
  `orkestrator-test-run.wNjCO4/` and `orkestrator-test-run.nTapJF/`, under the
  host temporary directory.
- **Assessment:** this observation remains non-green in isolation and does
  not establish a passing flake rerun. The earlier port-collision history is
  relevant, but neither it nor these reruns proves the cause of the aggregate
  ownership mismatch. No assertion, timeout, skip or preview implementation
  was changed. Static checks and the focused coordinator/storage guards passed.

## Recurrence during todo 0035 validation — 2026-10-26

- **Command:** `mise run test:logged -- --name full-test-3 -- mise run test` on
  branch `todo-0035-mobile-layout-gaps-49509c5f9933` (head `e61067baa`,
  renderer-only changes; it does not touch preview discovery). Root, bridges,
  the Codex protocol lockfile and every workspace package except backend
  passed (web 9,833 passed). Backend reported 11,765 passed and one failed.
- **Failure:** `local preview service discovery on this host > two
  environments, a restart on the reused port, and an auto-incremented port`
  (`preview-local-discovery.test.ts:617`, 793.72 ms). The same ownership
  mismatch as the storage-main merge above: `user-registered` received where
  `managed-process` was expected.
- **Complete unchanged owner rerun:**
  `mise run test:logged -- --name preview-discovery-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-local-discovery.test.ts --parallel=1 --only-failures`
  passed (8.2 s) at load average about 15.
- **Evidence:** `orkestrator-test-run.9PpU2I/` below the host temporary
  directory. No assertion, timeout or skip changed.


## Mobile settings review-fix validation — 2026-10-26

The review-fix `mise run test` on branch
`todo-0035-mobile-layout-gaps-49509c5f9933` used workspace/root/bridges/protocol
allocations of 4/1/2/1, with two backend workers. Backend finished with 11762
passed, 97 skipped and four failed across 703 files (636.58 s); the aggregate
finished in 654.9 s. Web passed 9834 tests. Aggregate evidence is
`orkestrator-test-run.x766cu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. The change touches no backend implementation
or backend tests.

`local preview service discovery on this host > two environments, a restart
on the reused port, and an auto-incremented port` failed at line 531
(441.53 ms): the fixture printed `EADDRINUSE` on loopback and its shell exited
before reporting a bound port.

The complete unchanged owner passed alone:
`mise run test:logged -- --name backend-preview-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-local-discovery.test.ts --parallel=1 --only-failures`
(4.3 s logged). This confirms intermittence for the port-collision recurrence;
it does not establish the cause. No assertion, timeout, skip or preview
implementation changed.
