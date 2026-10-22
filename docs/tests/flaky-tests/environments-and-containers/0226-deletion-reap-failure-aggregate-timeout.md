# Deletion that cannot reap a server: aggregate timeout (`apps/backend/tests/commands-registry-environments.test.ts`)

- **ID:** 0226
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server`
- **Owning file:** `apps/backend/tests/commands-registry-environments.test.ts:3617`
- **Original command:** `mise run test:logged -- --name full-suite-3 -- mise run test`
  on the default PATH, with the standard group slots. Other workers' suites
  were running on the same host.
- **Failure:** failed at 6,222.99 ms with no assertion message, past Bun's
  five-second default. The last log lines were the expected
  `Stopping codex:env-delete-failure` and `Environment cleanup step worktree failed`.
- **Suite counts:** backend 7,705 passed, 39 skipped, 1 failed (7,745 tests,
  423 files, 330.87 s). The web, root, bridges and protocol groups passed.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1`
  from `apps/backend`: 68 passed in 20.77 s.
- **Evidence:** `/tmp/orkestrator-test-run.AAEzu7/` and `/tmp/orkestrator-test-run.2uhUui/`.
- **Hypothesis:** host contention, as in 0211 and 0214. Not confirmed.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** the same deletion-reap case exceeded its five-second deadline
  at 5037.65 ms.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-environments -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 20.6 seconds (exit 0).
- **Disposition:** recurrence confirmed by the isolated pass; shared-host
  contention remains a hypothesis. No test, timeout or skip was changed.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `retains the environment and process ownership when deletion cannot reap a server` timed out after 5408.64 ms.
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-lifecycle-isolated -- bun test --cwd apps/backend ./tests/commands-registry-environments.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 40.4 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; the cause remains unconfirmed. No product code, assertion, timeout or skip was changed.

## Pane reset review recurrence — 2026-10-17

`mise run test:logged -- --name full-suite -- mise run test` used workspace,
root, bridge and protocol reservations of 4/1/2/1 slots while browser checks
and other worktrees used the host. The deletion-reap case exceeded its five-second deadline at 6799.93 ms.

`mise run test:logged -- --name environment-lifecycle-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
passed the unchanged owning file in 24.7 seconds (exit 0). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). No assertion, timeout or skip changed.

## Cleanup review follow-up recurrence (2026-10-17)

The same case timed out at 7434.46 ms in
`mise run test:logged -- --name review-tests -- mise run test`. The unchanged
owning file passed after the aggregate with one worker in 18.9 seconds.
Exact commands, worker configuration, suite counts and evidence are recorded
in [0194](0194-environment-lifecycle-deletion-aggregate-timeout.md#cleanup-review-follow-up-recurrence-2026-10-17).
No assertion, timeout or skip changed; host contention remains a hypothesis.

## Multi Review recovery validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-review-recovery -- mise run test` on `4443c027` plus the recovery changes, macOS arm64 under shared-host load. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers.
- Aggregate: backend 8,632 passed, 41 skipped, four failed and two between-tests errors across 463 files (525.39 seconds); outer run exited 1 after 549.9 seconds. Three failures were known five-second timeouts, and one provider-identity assertion was updated for the new lifetime wrapper and passed in its owning file. All other workspace packages and the root/bridge/protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.AdrtP5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YbWcld/full-review-recovery.log.gz`.
- The deletion-reap case timed out at 6812.46 ms.
- Unchanged owning-file rerun: `mise run test:logged -- --name lifecycle-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed in 20.3 seconds, exit 0.
- Shared-host contention and teardown after timeout remain hypotheses. No assertion, timeout, skip or implementation in this owner changed.


## Codex catalogue review final validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name final-full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, two isolated backend workers; other worktrees shared the host).
- **Aggregate:** backend 8814 passed, 41 skipped, ten failed and three
  between-tests errors across 8865 tests in 472 files (541.38 seconds).
  Toolchain had one failure; every other package and root/bridge/protocol
  group passed. Aggregate exited 1 after 852.0 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failures:** deletion-reap exceeded its 5000 ms deadline at 7186.38 ms.
  Companion `does not delete remote branches when a merged environment has no PR url`
  exceeded the same deadline at 5042.19 ms.
- **Post-aggregate owning-file rerun:** `mise run test:logged -- --name lifecycle-owner-post-aggregate -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 19.4 seconds).
- **Assessment:** the isolated pass confirms intermittence. Shared-host
  contention remains a hypothesis; no lifecycle implementation, assertion,
  timeout or skip changed.

## Pi and Cursor agent-test logins main merge validation — 2026-10-17

Aggregate command, worker configuration, counts and evidence are recorded in [0211](0211-cleanup-retry-aggregate-timeout.md#pi-and-cursor-agent-test-logins-main-merge-validation--2026-10-17).

- Failure: `retains the environment and process ownership when deletion cannot reap a server` exceeded its 5000 ms deadline at 5510.68 ms.
- Unchanged owning-file rerun: `mise run test:logged -- --name merge-deletion-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed, exit 0 (35.6 seconds).
- The owning-file pass confirms intermittence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

## Codex phantom-denials branch validation (2026-10-17)

Recurred in `mise run test` on `fix-codex-phantom-denials-8bdb8d15d820` (base
`9da80451`), whose diff touches no backend source, at 6,636.73 ms, alongside 0178 and 0310.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.6fSEkJ`.
The test passed alone (`bun test --preload ../../tests/setup-node.ts tests/commands-registry-environments.test.ts -t "deletion cannot reap a server"` from `apps/backend`) in 1.4 s.

## Slash catalogue main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU tools preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers alongside other worktrees on the shared host.
- **Failure:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server` exceeded its 5000 ms deadline at 5059.47 ms.
- **Suite counts:** backend reported 8933 passed, 41 skipped and four failed across 8978 tests in 476 files (639.61 seconds). All other workspace packages and root/bridge/protocol groups passed; aggregate exited 1 after 738.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lAr6wP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.S55BjO/merge-tests.log.gz` in the same temporary root.
- **Owning-file rerun:** `mise run test:logged -- --name merge-lifecycle-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 24.1 seconds).
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Further main merge at f51c7252 — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `f51c7252` into `17c19221`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated Bun workers alongside targeted browser and CLI validation on the shared host.
- **Failure:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server` exceeded its 5000 ms deadline at 5992.96 ms. The coordinator timeouts also produced late fixture errors after their deadlines.
- **Suite counts:** backend 9088 passed, 41 skipped and four failed across 9133 tests in 485 files (385.41 s); every other workspace package, root/support, bridges and protocol passed. Aggregate exited 1 after 445.1 s.
- **Owning-file rerun:** after the aggregate, the same GNU-tool PATH with `mise run test:logged -- --name refresh-main-owner-deletion -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 15.3 s. The three owning files ran sequentially.
- **Evidence:** `orkestrator-test-run.AP1Ws9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.TVK3dv/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.


## Upgrade-channel second main merge warm run — 2026-10-18

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge2-full-warm -- mise run test`, merging `origin/main` at `62c5c696` into `129e3887`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside Electron validation on the shared host.
- **Failure:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server` in `apps/backend/tests/commands-registry-environments.test.ts` exceeded 5000 ms at 6378.81 ms.
- **Suite counts:** backend 9109 passed, 41 skipped and six failed across 9156 tests in 486 files (579.33 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed; aggregate exit 1 after 596.4 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge2-environment-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged owning file (exit 0, 27.3 seconds).
- **Evidence:** `orkestrator-test-run.4BSigl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.EJfRvy/merge2-full-warm.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Keep-open picker agent-mail main merge — 2026-10-19

- **Original command:** the testing guide's macOS GNU-tool PATH prefix with `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `ef52cca4` into pre-merge HEAD `75e79aaf`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers alongside component and isolated-browser validation.
- **Failure:** `Electron backend environment lifecycle commands > retains the environment and process ownership when deletion cannot reap a server` exceeded 5000 ms at 6773.23 ms.
- **Aggregate result:** exit 1 after 524.9 seconds logged. Backend reported 9124 passed, 41 skipped, two failed and one between-test error across 9167 tests in 489 files (430.57 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed.
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed both unchanged owning files sequentially (exit 0, 26.7 seconds logged).
- **Evidence:** `orkestrator-test-run.EYsTWK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.MSInPe/merge-tests.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

## Queued-steer recovery validation recurrence — 2026-10-19

- **Revision:** `1ad88982`, branch `queued-prompt-steering-3970ea85ceea-r1`.
- **Original command:** `mise run test:logged -- --name queued-steer-handoff-full -- mise run test`, Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside another worktree's validation.
- **Failure:** the indexed test exceeded its 5000 ms deadline at 7861.13 ms. Coordinator timeouts were followed by two between-test errors from late Git work after fixture cleanup.
- **Suite result:** backend reported 9105 passed, 41 skipped, three failed and two between-test errors across 9149 tests in 486 files (339.43 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed. Aggregate exit 1 after 498.4 seconds, including the workspace resource wait.
- **Isolated rerun:** `mise run test:logged -- --name environment-timeout-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0 (13.9 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.JzdYLc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer run `orkestrator-test-run.MYt5Tx/queued-steer-handoff-full.log.gz` under the same temporary root.
- **Assessment:** owning-file passes confirm recurrence of the existing flakes. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip was changed; the queued-steer regression tests passed.

## Queued-steer main merge validation — 2026-10-19

The recurrence, owning-file results and remaining limitations are recorded in
[0501](../aggregate-validation-runs/0501-queued-steer-main-merge-validation.md). No owning implementation,
assertion, timeout or skip was changed for validation.

## Resolution — 2026-10-20

- **Root cause:** shared fixture state, not host load alone. `createContext` in
  `apps/backend/tests/command-fixtures.ts` defaults every context's data
  directory to one fixed path, `$TMPDIR/orkestrator-command-tests`, shared by
  every command-fixture file in every concurrent test process on the host
  (including other checkouts' runs). Every `delete_environment` records and
  updates the environment-cleanup ledger there: a SQLite database in WAL mode
  with `synchronous = FULL`, whose `bun:sqlite` busy handler blocks the event
  loop for up to ten seconds while another process holds the write lock. The
  ledger also accumulated entries across runs, and a deletion's background
  reconcile pass retried entries other processes had recorded under the same
  environment ids. Holding that database's write lock from another process for
  four seconds stalled `deletes the remote head branch during merged local
  environment cleanup` from about 0.1 s to 4,112 ms in an otherwise idle run;
  under six concurrent copies the whole-file times ran in lock-step (six copies
  finishing at an identical 21.56 s), the signature of cross-process blocking.
- **Fix:** `apps/backend/tests/commands-registry-environments.test.ts` now passes
  a per-process data directory (`orkestrator-command-environments-<pid>-*`, swept
  when stale, removed in `afterAll` after cancelling the scheduled reconcile and
  closing the ledger connection) to every context, and points its Docker fakes'
  ownership probe at that directory's owner namespace. The shared fixture is
  unchanged. The ten-process `createGitWorktreeWithOrigin` repository pair is
  built once per file and copied per test, and the remote-branch collision
  case creates its unfetched branch directly in the bare remote (one Git
  process instead of a clone, commit and push). Git subprocesses per file run
  fell from 347 to 235. No assertion, timeout or skip changed.
- **Verification:** the same four-second external lock no longer affects the
  file, and a full run leaves the shared ledger's revision unchanged. The file
  alone passed in 14.0–17.6 s (previously 16.7–24.6 s). Interleaved stress,
  six concurrent copies × four rounds per variant at load average 22–45:
  before, 24/24 passed with whole-file times of 16.0–29.1 s; after, 24/24 passed
  in 14.1–16.1 s.
  This case went from median 312 ms / max 469 ms to 90 ms / 139 ms; every
  other deletion case in the file (case 0194) improved the same way.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.
