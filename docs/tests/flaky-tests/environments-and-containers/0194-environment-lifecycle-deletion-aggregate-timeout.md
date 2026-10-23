# Environment lifecycle deletion cases time out in the aggregate

- **ID:** 0194
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Tests:** in `Electron backend environment lifecycle commands`:
  `deletes the remote head branch during merged running container cleanup`
  (8,786 ms), `does not delete remote branches when a merged container
  environment is not running` (7,738 ms), `does not delete remote branches when
  a merged environment has no PR url` (5,572 ms), `removes the environment even
  when remote branch deletion fails for a non-404 reason` (6,912 ms), and
  `retains the environment and process ownership when deletion cannot reap a
  server` (6,242 ms).
- **File:** `apps/backend/tests/commands-registry-environments.test.ts`
- **Original command:** `mise run test:logged -- --name full-tests-2 -- mise run test`
  on macOS; root group 4992 passed, 24 skipped, 19 failed, 3 errors across 253
  files in 390 seconds.
- **Failure:** each exceeded the five-second test timeout.
- **Isolated rerun:** `bun test ./apps/backend/tests/commands-registry-environments.test.ts`
  passed 68 of 68. The first full run of the same tree earlier that day also
  passed these cases.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.j4rNKa`.

The cases drive fake `git`, `docker` and `gh` shims under the default
five-second budget, like the resolved fixture-shim timeouts in case 0130.
Host contention is the likely cause; the isolated pass does not prove it. No
test was skipped, loosened, or changed to conceal the failure.

## Recurrence 2026-10-13

- **Tests:** `does not delete remote branches when a merged container
  environment is not running` (5,868 ms) and `retains the environment and
  process ownership when deletion cannot reap a server` (6,897 ms).
- **Original command:** `mise run test:logged -- --name electron-unit -- bun test
  tests/unit/electron --parallel=4 --only-failures` on macOS during the Electron
  44 upgrade (no change to the backend or this file); 1939 passed, 23 skipped,
  2 failed across 115 files in 261.6 seconds, with a host load average near 30
  from other concurrent agent runs.
- **Isolated rerun:** `bun test apps/backend/tests/commands-registry-environments.test.ts`
  passed in 81.1 seconds under the same host load.

## Recurrence during merge conflict validation (2026-10-13)

- **Original command:** the GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name merge-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots;
  root files used three isolated Bun workers. Browser validation also ran.
- **Root-suite counts:** 5,073 total, 5,044 passed, 24 skipped, 5 failed and
  1 additional error across 256 files in 238.08 seconds. Workspace, bridges,
  protocol and browser groups passed.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6mi44l/root-and-agent-support-tests.log.gz`
  and the adjacent `summary.json`.
- **Tests:** `deletes the remote head branch during merged running container cleanup`
  (6,616.41 ms), `does not delete remote branches when a merged container environment is not running`
  (6,340.66 ms), and `retains the environment and process ownership when deletion cannot reap a server`
  (5,531.92 ms), each exceeding its five-second deadline. The first timeout
  also produced a late missing-fixture `docker-rm.log` error after cleanup.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name merge-environments-isolated -- bun test ./apps/backend/tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 31.1 seconds.
- **Hypothesis:** the aggregate deadline failures match earlier observations;
  unchanged owning files pass alone. Contention may contribute, but the root
  cause remains unconfirmed. No assertion, timeout or skip was changed.

## Recurrence during version-reminder validation (2026-10-15)

- **Original command:** the macOS GNU-tool PATH from the testing guide with
  `mise run test:logged -- --name full-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees and browser
  checks also ran on the host.
- **Tests:** `deletes the remote head branch during merged running container cleanup`
  (5463.30 ms), `removes the environment even when remote branch deletion fails for a non-404 reason`
  (5079.02 ms), and `retains the environment and process ownership when deletion cannot reap a server`
  (6065.61 ms) each exceeded the five-second deadline.
- **Backend counts:** 7692 passed, 39 skipped, 5 failed and one additional
  error across 423 files in 340.15 seconds. The other failures were design
  sync (case 0193) and shutdown; the shutdown failure reproduced alone.
- **Isolated rerun:** `mise run test:logged -- --name lifecycle-rerun -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts
  --parallel=1 --only-failures` passed unchanged in 23.3 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.ZPe1mY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer summary `/tmp/orkestrator-test-run.e91mPJ/summary.json`.
- **Hypothesis:** the repeat timeout/pass pattern matches prior observations;
  contention may contribute, but the cause remains unconfirmed. No assertion,
  timeout or skip was changed.

## Recurrence during cleanup follow-up merge validation (2026-10-15)

- **Original command:** the testing guide's macOS GNU-tool PATH with
  `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots.
- **Test:** `retains the environment and process ownership when deletion cannot reap a server`
  exceeded the five-second deadline at 5962.33 ms.
- **Backend counts:** 7716 passed, 39 skipped, 2 failed across 424 files in
  355.67 seconds. The other failure was the shutdown deadline test; root,
  bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-lifecycle-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts
  --parallel=1 --only-failures` passed unchanged in 28.8 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.g8b6ma/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer summary `/tmp/orkestrator-test-run.VaL2oK/summary.json`.

The shutdown deadline test also failed when its owning file
(`apps/backend/src/core/index.test.ts`) was rerun alone after incorporating
newer main changes (27 passed, 1 failed; 1.4 seconds; evidence
`/tmp/orkestrator-test-run.gJpAGh`). That separate failure is reproducible and
is not classified as a flake.

The cause remains unconfirmed. No assertion, timeout or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Command:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots on the shared host.
- **Failure:** `retains the environment and process ownership when deletion cannot reap a server` exceeded the five-second deadline at 5133.55 ms. No environment lifecycle code changed.
- **Owning-file rerun:** `mise run test:logged -- --name backend-deletion-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed unchanged in 58.4 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after finalization. No assertion, deadline or skip changed; the load hypothesis remains unconfirmed.

## Pane reset review recurrence — 2026-10-17

`mise run test:logged -- --name full-suite -- mise run test` used workspace,
root, bridge and protocol reservations of 4/1/2/1 slots while browser checks
and other worktrees used the host. `continues merged environment cleanup when the remote head branch is already deleted` (5102.67 ms) and `does not delete remote branches during closed environment cleanup` (5248.06 ms) exceeded their five-second deadlines.

`mise run test:logged -- --name environment-lifecycle-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
passed the unchanged owning file in 24.7 seconds (exit 0). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). No assertion, timeout or skip changed.

## Cleanup review follow-up recurrence (2026-10-17)

- **Original command:** the testing guide's macOS GNU-tool PATH with
  `mise run test:logged -- --name review-tests -- mise run test` on
  `todo/env-cleanup-realstack-qualification` (`160610af` plus review fixes).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots;
  backend used two isolated Bun workers. Other worktrees shared the host;
  workspace admission waited 361.3 seconds.
- **Failures:** seven cases exceeded the 5000 ms budget:
  `deletes the remote head branch during merged local environment cleanup`
  (5145.33 ms), `continues merged environment cleanup when the remote head branch is already deleted`
  (5287.29 ms), `does not delete remote branches during closed environment cleanup`
  (5152.93 ms), `removes the environment even when remote branch deletion fails for a non-404 reason`
  (5125.16 ms), `does not delete remote branches when a merged environment has no PR url`
  (5482.02 ms), `does not delete remote branches when a merged container environment is not running`
  (5279.35 ms), and `retains the environment and process ownership when deletion cannot reap a server`
  (7434.46 ms, also tracked in 0226).
- **Counts:** backend 8612 passed, 41 skipped, eight failed and one late
  SQLite error across 8661 tests in 461 files (442.50 seconds). The other
  timeout and late error belong to 0165. All other workspace packages, root,
  bridges and protocol passed; aggregate exited 1 after 840.1 seconds.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name review-lifecycle-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0) in 18.9 seconds after the aggregate.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.qwtTNi/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.wJM0al/review-tests.log.gz`.
- **Assessment:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis. No product code, assertion, timeout or skip changed.

## Retired-dispatch recovery validation — 2026-10-17

The full `mise run test:logged -- --name full-tests -- mise run test` run reported five-second timeouts for `deletes the remote head branch during merged local environment cleanup` (5464.74 ms), `does not delete remote branches during closed environment cleanup` (5749.17 ms), and `retains the environment and process ownership when deletion cannot reap a server` (5390.55 ms, also case 0226). Backend results: 8784 passed, ten failed. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YP2Uc2/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name environments-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 20.4 seconds. No lifecycle implementation, assertion, timeout or skip changed.

## Recurrence — 2026-10-17 (device-login review fixes)

`mise run test:logged -- --name login-full-tests -- mise run test` timed out
`does not delete remote branches during closed environment cleanup` at 5065.31 ms
and `retains the environment and process ownership when deletion cannot reap a server`
at 5953.57 ms. The workspace group reserved four slots and waited
408.7 seconds for host capacity. The unchanged owning file passed alone
(exit 0, 27.3 seconds):

```bash
mise run test:logged -- --name login-environment-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.rIDYEp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed when the aggregate finishes) in the host temporary directory.
No implementation, assertion, timeout or skip was changed.

## Design live-cycle second main merge — 2026-10-18

The GNU-tool PATH `merge-full` aggregate (workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) timed out non-404 remote deletion (5251.01 ms), deletion without a PR URL (5292.57 ms), and retaining ownership after a server could not be reaped (8706.36 ms; case 0226). The unchanged owning file passed `mise run test:logged -- --name merge-unit-owner-commands-registry-environments -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures`, exit 0, in 30.9 seconds logged. Aggregate evidence: `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; no implementation, assertion, timeout or skip changed.

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
  Deletion cases, before → after (median / max ms): merged local cleanup
  242/634 → 70/122; already-deleted head branch 249/622 → 75/108; closed
  cleanup 218/519 → 48/248; non-404 failure 204/327 → 72/126; no PR URL
  203/263 → 46/62; deletion that cannot reap a server 312/469 → 90/139. The two
  container cases are dominated by fake-Docker shell spawns and were unchanged
  (merged running container 359/560 → 306/390; stopped container 305/776 →
  261/308); they no longer stall on the shared ledger.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.
