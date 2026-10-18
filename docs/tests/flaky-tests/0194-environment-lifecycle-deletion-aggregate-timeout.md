# Environment lifecycle deletion cases time out in the aggregate

- **ID:** 0194
- **Status:** open
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
