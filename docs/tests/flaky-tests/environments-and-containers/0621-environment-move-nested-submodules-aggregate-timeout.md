# Moving a worktree with nested submodules times out in the aggregate

- **ID:** 0621
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `move_environment > moves a worktree with nested submodules (same disk)`
  in `apps/backend/src/core/environment-move.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests-0a835 -- mise run test`
  on branch `qualify-preview-electron-remaining-cases-0a835a98d18e`, which
  changes no backend code, on a macOS 27.0 arm64 host shared with other
  live-test worktrees (load average 16 to 36).
- **Failure:** the five-second test timeout (5055.85 ms) while
  `expectSubmodulesLinked` was running its git checks.
- **Alone:** `bun test --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1`
  in `apps/backend`: 37 passed (28.78 s) at load 36.
- **Related:** the same file's five-second aggregate timeouts in
  [0291](0291-environment-move-submodule-aggregate-timeout.md) and
  [0248](0248-move-restart-recovery-submodule-timeout.md) (other tests, the
  same git-heavy submodule fixtures).
- **Hypothesis:** submodule git commands exceed the default five seconds under
  aggregate load, as in 0291. Not confirmed. No timeout was raised and no test
  was skipped.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.txKi1Z/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Recurrence, 2026-10-23 (copy variant)

- **Test:** `move_environment > moves a worktree with nested submodules (copy)`, the cross-disk sibling of the original case.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on the todo 0019 branch (base `06297124`, no change to environment moves), host load average 12–60.
- **Failure:** timed out after 5000 ms (5084.32 ms).
- **Owning-file rerun:** `mise run test:logged -- --name move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1` passed in 20.1 s at load 13.
- **Evidence:** `orkestrator-test-run.Gqog9k` below the host temporary directory. No timeout was raised and no test was skipped.

## Native agent collaborator extraction — 2026-10-23

- **Failure:** both `move_environment > moves a worktree with nested submodules (same disk)` (5121.23 ms) and the `(copy)` variant (5049.17 ms) hit the five-second timeout in the same run.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on `todo-0010-native-agent-collaborators-3fc4749e0985` (native agent service refactor; no environment-move or Git code changed), macOS arm64, Bun 1.4.2.
- **Suite counts:** backend 10,120 passed, 86 skipped, 3 failed across 592 files (544.12 s); web 8,818 passed; root/support, bridges and the Codex protocol lockfile passed.
- **Owning-file rerun:** `mise run test:logged -- --name env-move-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed twice (35.4 s and 36.7 s logged).
- **Evidence:** `orkestrator-test-run.EveQv4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Environment marker review fixes — 2026-10-23

- **Original command:** `mise run test:logged -- --name default-tests -- mise run test` on `environment-status-indicator-8f5602a246be-r1`; no backend or Git implementation changed.
- **Failure:** `move_environment > moves a worktree with nested submodules (same disk)` timed out after five seconds (5054.20 ms) in `expectSubmodulesLinked`, followed by a terminated Git command reporting an invalid submodule gitfile.
- **Owning-file rerun:** `mise run test:logged -- --name backend-submodule-recheck -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged (34.4 s logged).
- **Evidence:** `orkestrator-test-run.45VcQo/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Changes:** recorded recurrence only; no backend tests, timeouts or skips changed.

## Design links resume identity validation — 2026-10-25

- **Failure:** `move_environment > moves a worktree with nested submodules (same disk)` timed out (5231.33 ms).
- **Original command:** `mise run test` on `todo-0038-design-conversation-links-852aa84d76e8` (commit `f771a8b8c`; native-session resume identity and teardown fallback, no environment-move or Git code changed), Bun 1.4.4, default reservations, host load average 37–52 from other workers.
- **Aggregate counts:** backend 11,437 passed, 89 skipped, 3 failed across 681 files (796.55 s); the third failure is the new owner case [0930](../backend-services-and-tooling/0930-coordinator-codex-login-renewal-loginless.md).
- **Owning-file rerun:** `mise exec -- bun test --preload ../../tests/setup-node.ts src/core/environment-move.test.ts` from `apps/backend` passed unchanged twice (37 pass, 0 fail each).
- **Evidence:** `orkestrator-test-run.ZkIWTS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Changes:** recorded recurrence only; no test, timeout, assertion or skip changed.

## Recurring-work qualification validation — 2026-10-25

- **Original command:** `mise run test:logged -- --name full-0048 -- mise run test` on `todo-0048-recurring-work-qualification-dbe14f8256cc` (storage read path, recurring-work harness and scripts only), macOS 27.0 arm64, Bun 1.4.4, standard worker leases.
- **Failure:** the same-disk nested-submodule move exceeded five seconds (5224.36 ms).
- **Owning-file reruns:** passed in the three-file rerun `mise run test:logged -- --name owners-0048 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/coordinator-service.test.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`. A later rerun of the file alone at load average 55 (`--name env-move-owner-0048`) failed it at 10005.30 ms together with the `(copy)` variant (5042.92 ms) and case 0248. Evidence: `orkestrator-test-run.fSNcim/` and `orkestrator-test-run.f5VfI7/`.
- **Aggregate evidence:** `orkestrator-test-run.VrI5KW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (enclosing log `orkestrator-test-run.JFzi7O/full-0048.log.gz`) under the host temporary directory. Backend 11433 passed, 89 skipped and 4 failed across 11526 tests in 680 files (872.95 s); web 9760 passed; root/support, bridges and the Codex protocol lockfile passed. Test groups finished in 942.4 s; the run exited 1.
- **Assessment:** recurrence under heavy host load; no owning code, assertion, deadline or skip changed.

## Voice qualification review fixes — 2026-10-25

- **Change:** `9b1b42be8`; only CLI voice examples and their tests changed.
- **Original command:** `mise run test:logged -- --name voice-suite -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1, with other worktrees validating on the same host.
- **Failure:** The nested-submodule same-disk move exceeded its five-second deadline (5156.02 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name environment-move-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed, exit 0 in 42.5 seconds logged.
- **Evidence:** `orkestrator-test-run.OeJQLs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** recurrence of this tracked intermittent failure. No implementation, assertion, timeout or skip changed in the owner; the aggregate result is not made green by the isolated pass.

## Codex resume-context review validation — 2026-10-26

`mise run test:logged -- --name repository-tests -- mise run test` used
workspace/root/bridges/protocol reservations of 4/1/2/1 slots, with two Bun
workers for backend. The same-disk nested-submodule move timed out at 5130.43 ms against its
five-second deadline while `addNestedSubmodules` was running Git.

The complete unchanged owner passed alone, exit 0 in 42.2 seconds:

```sh
mise run test:logged -- --name environment-move-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: host temporary directory
`orkestrator-test-run.unZQTH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed on aggregate completion), enclosing log
`orkestrator-test-run.2JILAH/repository-tests.log`. No backend implementation,
test, assertion, deadline or skip changed. The aggregate remains failed.

Aggregate backend totals: 11,196 passed, 95 skipped, three failed and one
error across 655 files (501.24 s). The groups finished in 1010.2 s; exit 1.
The timed-out Git reset was terminated with SIGTERM and rejected between tests.

## Claude Linux sandbox probe (todo 0145) — 2026-10-26

- **Original command:** `mise run test` on macOS, Bun 1.4.4, branch `todo-0145-claude-linux-sandbox-39a58b878dd6` (head `4c54d788e`), with other worktrees validating on the host (load average about 21).
- **Failure:** `move_environment > moves a worktree with nested submodules (copy)` exceeded its five-second deadline (5201.28 ms), alongside 0950 and 0951 in the same run.
- **Complete unchanged owner:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1` passed (37 pass, 0 fail).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pHWGe9`.
- **Assessment:** recurrence of this tracked intermittent failure. No implementation, assertion, timeout or skip changed.

## Paired AppArmor qualification validation — 2026-10-26

- **Original command:** `mise run test:logged -- --name apparmor-full -- mise run test` on `todo-0145-claude-linux-sandbox-39a58b878dd6`, Bun 1.4.4 on macOS arm64. Standard workspace/root/bridge/protocol worker reservations were 4/1/2/1; the backend used two workers. The change adds qualification tests and CI steps only, with no environment-move or Git changes.
- **Failure:** `move_environment > moves a worktree with nested submodules (copy)` timed out at 5038.02 ms, followed by a terminated Git child error in `expectSubmodulesLinked` after fixture cleanup.
- **Aggregate result:** backend 11,767 passed, 97 skipped, one failed and one follow-on error across 703 files (523.84 s). All other workspace packages, root/support, bridges and protocol lockfile passed. The enclosing run exited 1 after 550.6 s.
- **First unchanged owning-file rerun:** `mise run test:logged -- --name environment-move-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the original copy case but timed out the same-disk sibling at 5035.25 ms (36 passed, one failed and one follow-on error; 39.6 s). Host load averages measured afterward were 13.46/18.47/27.33.
- **Second unchanged owning-file rerun:** the identical command with `--name environment-move-second-owner` passed the complete file, exit 0 (35.7 s).
- **Evidence:** `orkestrator-test-run.WnNxeb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, enclosing `orkestrator-test-run.ZW79NR/apparmor-full.log.gz`, and first owner `orkestrator-test-run.z6UYA0/` under the host temporary directory.
- **Assessment:** the same existing five-second Git-heavy fixture timeout alternated between variants before the whole file passed. No implementation, timeout, assertion or skip was changed; the isolated pass does not make the aggregate result green.

## On-demand file-tree review fixes — 2026-10-26

- **Original command:** `mise run test:logged -- --name repo-tests -- mise run test`, Bun 1.4.4 on macOS; workspace/root/bridges/protocol reservations 4/1/2/1, with two backend workers. Component browser and disposable-stack browser validation also ran on the host.
- **Failure:** `move_environment > moves a worktree with nested submodules (same disk)` exceeded the five-second deadline at 5112.41 ms, with a terminated recursive Git child.
- **Complete unchanged owning file:** `mise run test:logged -- --name environment-move-isolated -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed, exit 0 in 50.4 seconds.
- **Evidence:** `orkestrator-test-run.7ku54G/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and enclosing `orkestrator-test-run.o7QG5Q/repo-tests.log.gz` under the host temporary directory.
- **Aggregate backend counts:** 11,580 passed, 101 skipped, four failed and two between-test errors across 677 files (822.94 s).
- **Assessment:** recurrence of this existing timing failure. No environment-move code, assertion, timeout or skip changed; the isolated pass does not make the aggregate green.
