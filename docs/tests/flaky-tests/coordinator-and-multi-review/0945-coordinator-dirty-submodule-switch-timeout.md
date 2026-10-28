# Coordinator dirty-submodule discarding switch times out in the aggregate

- **ID:** 0945
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `project coordinator > a dirty submodule needs enhanced confirmation before a discarding switch`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-0048 -- mise run test` on `todo-0048-recurring-work-qualification-dbe14f8256cc` (storage read path, recurring-work harness and scripts only), macOS 27.0 arm64, Bun 1.4.4, standard worker leases; host load average 50 to 55.
- **Failure:** the case exceeded Bun's five-second deadline (5128.46 ms).
- **Isolated rerun:** `mise run test:logged -- --name owners-0048 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/coordinator-service.test.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`: this case passed; the three files gave 113 passed, 1 failed (case [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)) and one between-test error (176.81 s). Evidence: `orkestrator-test-run.fSNcim/owners-0048.log.gz` under the host temporary directory.
- **Aggregate evidence:** `orkestrator-test-run.VrI5KW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (enclosing log `orkestrator-test-run.JFzi7O/full-0048.log.gz`) under the host temporary directory. Backend 11433 passed, 89 skipped and 4 failed across 11526 tests in 680 files (872.95 s); web 9760 passed; root/support, bridges and the Codex protocol lockfile passed. Test groups finished in 942.4 s; the run exited 1.
- **Related:** resolved cases [0461](0461-coordinator-fetch-remotes-submodule-timeout.md), [0480](0480-coordinator-fetch-remotes-submodule-timeout.md) and [0490](0490-coordinator-fetch-remotes-aggregate-timeout.md) covered the earlier, combined fetch-and-submodule case in the same file.
- **Hypothesis:** the case builds a real repository with a dirty submodule and runs several Git commands; at load average 50 they exceed five seconds. Unconfirmed. No coordinator code, assertion, deadline or skip changed.

## Main-merge validation recurrence (2026-10-27)

Merging `863b578217fca437c37c53372bec7a4f97719079` into
`711de8869705b8672a214aeb4d82c408a055c2d0` and running
`mise run test:logged -- --name merge-repository-tests -- mise run test`
repeated `project coordinator > a dirty submodule needs enhanced confirmation
before a discarding switch` at 5113.39 ms. The aggregate used two backend
workers, with the other repository groups running concurrently. The owner
and its implementation were outside the original conflict resolution.

The complete unchanged owner passed, exit 0 in 15.3 s:
`mise run test:logged -- --name merge-coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`.
This supports a recurrence of the existing deadline flake; it does not
establish its cause. No assertion, timeout, skip, or implementation changed.
Aggregate evidence is in
`orkestrator-test-run.2onpQ5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory; complete run results are recorded in
[1013](../aggregate-validation-runs/1013-interactive-command-main-merge-validation.md).


## Storage-maintenance review fixes recurrence (2026-10-27–28)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) timed out in `project coordinator > a dirty submodule needs enhanced
confirmation before a discarding switch` after 5178.72 ms against its 5000 ms
deadline, followed by a between-test Git-switch rejection. The host load
average was subsequently observed at 138.87.

The complete unchanged owner passed alone (exit 0, 44.0 s):

```sh
mise run test:logged -- --name coordinator-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory in
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The aggregate remains non-green. Contention is a hypothesis; the owner,
implementation and deadlines were unchanged.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.
