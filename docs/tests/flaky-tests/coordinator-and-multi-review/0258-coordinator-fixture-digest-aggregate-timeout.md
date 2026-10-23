# Coordinator fixture digest times out in the aggregate

- **ID:** 0258
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `fixture tree digest > names every class of change a coordinator could make`
- **Owning file:** `apps/desktop/scripts/dev/coordinator-live.test.ts`
- **Original command and workers:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities available in PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers and root used one. Component and isolated-stack browser validation ran alongside it.
- **Failure:** The 5000 ms deadline expired at 5028.75 ms; a racing `git symbolic-ref` exited -1 and produced an error between tests.
- **Suite counts:** Desktop: 729 passed, one failed, one error across 730 tests (51.74 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-coordinator-digest-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 3.1 s, with the same PATH preference.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** process and filesystem contention on the shared host is plausible but unconfirmed. No assertion, timeout or skip was changed.

## Codex sub-agent review validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots, alongside other worktree validations and the component browser suite.
- **Failure:** the same case exceeded its 5000 ms budget at 5012.40 ms; a racing `git rev-parse` exited -1 and produced an error between tests.
- **Suite counts:** desktop reported 729 passed, one failed and one between-tests error across 730 tests. The aggregate exited 1 after 582.8 seconds; backend timeout recurrences are recorded in 0162, 0165 and 0211. Root failed on the pre-existing missing metadata in case 0265; bridges and protocol verification passed.
- **Owning-file rerun:** `mise run test:logged -- --name fixture-digest-isolated -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 4.9 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8J9UKQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Container platform qualification recurrence — 2026-10-17

`mise run test` on branch `todo-container-live-qualification-8efe5278910a-r1`
(based on `31d0fb06`, no desktop source changes) timed out again at 5022.08 ms,
again with `git rev-parse exited -1` as an error between tests. Host load
average was about 20–33 on 18 cores, with nine other environments testing. The
unchanged owning file passed alone: `mise exec -- bun test --cwd apps/desktop
--preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts
--parallel=2 --only-failures` reported 30 passed in 4.94 s. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.v19VcP`.
No assertion, timeout or skip changed.

## Coordinator launch-base review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name review-aggregate -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots. The component browser suite ran alongside the aggregate.
- **Failure:** the same fixture digest test exceeded its 5000 ms budget at 5007.73 ms, with a racing `git rev-parse exited -1` between-tests error.
- **Suite counts:** desktop reported 776 passed, one failed and one between-tests error across 777 tests in 60.32 seconds.
- **Isolated rerun:** `mise run test:logged -- --name review-fixture-digest-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 1.2 seconds after the component browser suite ended. The rerun preferred system Python and the testing guide's GNU utilities in PATH.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HDY6ow/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. Shared-host contention remains an unconfirmed hypothesis; no implementation, assertion, timeout or skip changed.
- **Subsequent aggregate:** `mise run test:logged -- --name review-aggregate-system-tools -- mise run test` passed all four groups (exit 0, 339.7 seconds) with system Python and the documented GNU utilities preferred in PATH, after component browser validation ended. This pass does not establish a root cause or resolve the tracked flake.

## Device-login follow-up main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name upstream-merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host. Workspace admission waited 197.0 seconds; package suites used two isolated Bun workers.
- **Failure:** the fixture digest case timed out at 5018.38 ms against its 5000 ms limit, with a racing `git for-each-ref exited -1` between-tests error.
- **Suite counts:** desktop reported 776 passed, one failed and one error across 777 tests in 58 files (30.36 seconds). Backend had the known 0165 timeout; root had missing metadata in case 0280, corrected and verified separately. Bridges and protocol passed; aggregate exited 1 after 681.0 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name upstream-coordinator-fixture-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures`, with the same PATH preference, passed unchanged (exit 0) in 4.6 seconds while the aggregate was still active.
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.68dTo8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1Mw2VS/upstream-merge-tests.log.gz`.
- **Assessment:** the isolated pass confirms recurrence. Shared-host contention remains unconfirmed; no product code, assertion, timeout or skip changed in the resolution.

## Device-login preview-tunnel main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities preferred in PATH (Bun 1.4.3, macOS arm64), validating merge commit `55289cbb`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host; package suites used two isolated Bun workers. Protocol admission waited 40.3 seconds.
- **Failure:** the fixture digest case exceeded its 5000 ms deadline at 5019.38 ms, with a racing `git rev-parse exited -1` between-tests error.
- **Suite counts:** desktop reported 778 passed, one failed and one error; backend reported 8,863 passed, 41 skipped and zero failed. The other workspace packages, root/support, bridges and protocol check passed. The aggregate exited 1 after 372.2 seconds logged.
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-fixture-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures`, with the same PATH preference, passed unchanged (exit 0) in 2.4 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.d6VeYP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.teb7ai/merge-tests.log.gz`.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains unconfirmed; no implementation, assertion, timeout or skip changed. Conflict resolutions only combined documentation histories.

## Codex stored-model main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reserved 4/1/2/1 slots).
- **Failure:** the fixture digest case exceeded its 5000 ms deadline at 5011.64 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-desktop-digest-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 3.5 seconds).
- **Evidence:** `orkestrator-test-run.bQMvqV/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; outer run `orkestrator-test-run.4bGaMi/merge-tests.log.gz`.
- **Assessment:** the isolated pass confirms an intermittent recurrence. No implementation, assertion, timeout or skip changed.

## Grok-trust follow-up main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test` (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations 4/1/2/1 slots on the shared host; workspace admission waited 763.8 seconds).
- **Failure:** the fixture digest case exceeded its 5000 ms deadline at 5010.47 ms, with a racing `git worktree add` between-tests error. Desktop reported 778 passed, one failed and one error across 779 tests in 59 files (19.55 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-coordinator-fixture-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures`, with system Python preferred in PATH, passed unchanged (exit 0, 4.3 seconds logged).
- **Evidence:** `orkestrator-test-run.GfKwdw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory (compressed when the aggregate completes).
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains unconfirmed. No implementation, assertion, timeout or skip changed; conflict resolutions combined documentation histories.

## Codex phantom-denials PR-stage recurrence — 2026-10-17

- **Original command:** `bun test scripts/dev/coordinator-live.test.ts` from `apps/desktop`, alone rather than in the aggregate, on `fix-codex-phantom-denials-8bdb8d15d820` while other worktrees validated (load average about 26–31 on 18 cores).
- **Failure:** the same case exceeded its 5000 ms budget at 5033.25 ms, with a racing `git status exited -1` between-tests error.
- **Suite counts:** 45 passed, one failed and one between-tests error across 46 tests in 6.12 seconds.
- **Rerun:** the same command passed all 46 unchanged; so did the case alone (`-t "fixture tree digest"`, 3 passed) and the file with the runner tests under `--preload ../../tests/setup-node.ts` (52 passed).
- **Evidence:** terminal output only; no log file was kept.
- **Assessment:** the first case outside the aggregate. The branch changes the rollout reader in the same file but not the digest. Shared-host contention remains an unconfirmed hypothesis; no implementation, assertion, timeout or skip changed.

## Multi Review restart/reminders main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, Bun 1.4.3 on macOS arm64, with system Python and the testing guide's GNU utilities preferred in PATH. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; workspace admission waited 730.8 seconds on the shared 18-slot host, then package suites used two isolated Bun workers.
- **Failure:** `fixture tree digest > names every class of change a coordinator could make` in `apps/desktop/scripts/dev/coordinator-live.test.ts` exceeded its 5000 ms deadline at 5033.88 ms. A late `git rev-parse` reported that its working directory no longer existed after fixture teardown. Desktop reported 778 passed, one failed and one between-tests error across 779 tests in 59 files (29.02 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-desktop-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 4.1 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.6MFbQs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer run `orkestrator-test-run.6OCSFI/merge-full-tests.log.gz`.
- **Assessment:** the isolated pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. The conflict resolution changes documentation only; no source, assertion, timeout or skip changed.

Final aggregate: exit 1 after 1252.7 seconds logged. Backend passed 8964 tests with 41 skipped and no failures; all other workspace packages except desktop passed. Bridges and the Codex protocol check passed. The only failed cases were this runtime-staging timeout and the desktop fixture-digest timeout (0178/0258).

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-test -- mise run test` on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`, on a host at load average 36–69 with several live
suites running in other environments. Failed at 5072.95 ms. Workspace and root
artifacts:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQLOD6/`.
The unchanged owning file passed alone (48 pass, 2.3 s, after failing twice more at 5.0 s while load was 69).

## Recurrence during real-Electron service-preview qualification (2026-10-18)

- **Command:** `mise run test:logged -- --name full-tests -- mise run test` on
  a macOS arm64 host shared with other live-test worktrees (load average
  around 30), on branch `qualify-preview-electron-tunnel-c6ca4deaffee`.
- **Failure:** the same test timed out at 5 s; the follow-on
  `git rev-parse exited 128: Unable to read current working directory` came
  from the timed-out test's removed fixture directory.
- **Isolated rerun:** `mise run test:logged -- --name coordinator-live-alone -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1`
  passed in 2.1 s. The owning file was unchanged on the branch.

## Recurrence during recurring-work qualification (2026-10-22)

- **Command:** `mise run test:logged -- --name full-tests -- mise run test` on
  a macOS arm64 host, branch `todo-0048-recurring-work-qualification-6e2a0df806d3`,
  just after the branch's live isolated-profile A/B runs ended.
- **Failure:** the same test timed out at 5017.57 ms. Desktop package: 1111
  pass, 14 skip, 1 fail.
- **Isolated rerun:** `mise run test:logged -- --name desktop-fixture-digest -- bun test --cwd apps/desktop ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures`
  passed in 1.8 s. The owning file was unchanged on the branch. No timeout,
  assertion or skip changed.


## Sidebar collision main merge — 2026-10-22

- **Merge parents:** feature `8106d7821` and main `7b1066bc1`.
- **Original command:** `mise run test:logged -- --name merge-final-full-suite -- mise run test`, Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 workers; component browser validation ran alongside the aggregate.
- **Failure:** `fixture tree digest > names every class of change a coordinator could make` exceeded its 5000 ms deadline (5039.55 ms). Desktop reported 1,175 passed, 14 skipped and one failed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-coordinator-fixture-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 1.5 seconds logged.
- **Evidence:** `orkestrator-test-run.jPvcE5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence; contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Cross-service read policy validation recurrence — 2026-10-23

`mise run test` with the 0054 change (no desktop source changes) timed out at 5022.15 ms with `git rev-parse exited -1` between tests, at host load about 43. The owning file failed alone once more (5022.78 ms, `git rev-parse` exited 128: "Unable to read current working directory") and then passed alone in 5.6 s (`coordinator-live-alone-2`). Details in [0696](../aggregate-validation-runs/0696-cross-service-reads-validation.md). No assertion, timeout or skip changed.
