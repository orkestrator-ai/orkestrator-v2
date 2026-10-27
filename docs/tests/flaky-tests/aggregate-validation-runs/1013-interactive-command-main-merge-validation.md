# Interactive command main merge validation

- **ID:** 1013
- **Status:** open
- **Date observed:** 2026-10-26
- **Parents:** feature `4401a71829fc3bf7c61b50366d443b57ea457ec8` and main `6048aad1ae77f4639e4ffbdc9a38837789137daa`.
- **Original command:** `mise run test:logged -- --name merge-repository -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, including two backend workers. Component-browser validation also ran on the host.
- **Aggregate:** backend 11,960 passed, 141 skipped, 11 failed and seven errors across 719 files (1196.99 s); root/support 3,524 passed, four failed and one error (439.93 s). Aggregate exit 1 after 1354.0 s. Web passed all 9,937 active tests; bridges and protocol passed.
- **Evidence:** `orkestrator-test-run.uWXxA5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, `orkestrator-test-run.uWXxA5/root-and-agent-support-tests.log.gz`, and enclosing `orkestrator-test-run.doKdov/merge-repository.log.gz` below the host temporary directory.

## Complete backend owning-file reruns

Every command used `mise run test:logged -- --name <label> -- bun test --cwd apps/backend <path> --parallel=1 --only-failures`. Every complete owning file passed unchanged, exit 0. No assertion, deadline, skip or implementation was changed for these observations.

| Label | Path | Aggregate failure | Complete owner result |
| --- | --- | --- | --- |
| merge-poll-owner | `./tests/tmux-poll.test.ts` | `ClaudeStatePollManager > rechecks and retires an unchanged poll after fifteen seconds`, wait condition timeout, 68361.04 ms | passed, 4.2 s |
| merge-command-owner | `./src/core/public-api/public-api-command-surface.test.ts` | `session.start delivery options > a first prompt can be literal and carry attachments`, undefined recorded prompt, 68709.75 ms | passed, 1.2 s |
| merge-docker-image-owner | `./tests/docker-image.test.ts` | `topology gate > a budget a rootless daemon cannot enforce is refused before anything is created`, 110210.38 ms; `with no budget set a new runtime gets the built-in default, minus axes the daemon cannot enforce`, unexpected resource argument, 236.31 ms | passed, 5.2 s |
| merge-build-interactions-owner | `./src/core/build-pipeline-service-interactions.test.ts` | `BuildPipelineService > retries an addressing interaction with the findings prompt in build mode`, deadline, 113160.32 ms | passed, 0.8 s |
| merge-content-browser-owner | `./src/core/transcript-artifacts/content-server.browser.test.ts` | `served executable document in Chromium > runs inside a permitted ancestor's sandboxed iframe and is refused elsewhere`, deadline, 113719.22 ms | passed, 2.7 s |
| merge-schedules-owner | `./src/core/scheduled-jobs/coordinator-schedules.test.ts` | `coordinator schedules > a scheduled launch runs the coordinator's own launch_environment with the base resolved at fire time`, 8092.19 ms | passed, 0.5 s |
| merge-tailscale-owner | `./src/tailscale-serve.test.ts` | `Tailscale Serve manager > runs the default command runner through an executable boundary`, rejected promise, 130531.65 ms | passed, 0.3 s |

Additional confirmed recurrences update existing cases: [0205](../backend-services-and-tooling/0205-build-pipeline-scheduling-timeouts.md), [0340](../previews-annotations-and-gateway/0340-preview-relay-read-after-eof.md), [0690](../environments-and-containers/0690-github-missing-pat-scratch-directory-left.md), and [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md).

Several unrelated files timed out in the same portion of the aggregate, with reported durations far beyond five seconds. Host scheduling or suspension is a hypothesis; this run does not establish a cause. Isolated passes do not make the aggregate green.

## Failures that reproduce alone

- Browser components: `mise run test:logged -- --name merge-browser -- mise run test:browser` had 771 passed, 103 skipped and two failed with nine workers (479.8 s). Both native branch-suggestion cases in `e2e/AgentLaunchDialog.spec.ts` expected `release/2.0`, received `rel`. The complete unchanged one-worker owner (`--name merge-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`) retained both failures (two passed, two failed, 22.7 s). Evidence: `orkestrator-test-run.zBdNl8/merge-browser.log.gz` and `orkestrator-test-run.ay8wcI/merge-branch-owner.log.gz`. This is the already recorded native-control limitation in [0493](0493-component-browser-aggregate-timeout-cluster.md), not a new flake classification.
- Desktop: `mise run test:logged -- --name merge-desktop-owner -- bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1 --only-failures` retained both unexpected `keychainWarning` fields (20 passed, two failed, 0.8 s). Evidence: `orkestrator-test-run.tPxVay/merge-desktop-owner.log.gz`.
- Copy helper: `mise run test:logged -- --name merge-copy-owner -- bun test ./tests/unit/migrate-copy.test.ts --parallel=1 --only-failures` retained both missing-completion assertions: expected extraction status 0, received 2 (10 passed, two failed, 1.7 s). Evidence: `orkestrator-test-run.BYhRBM/merge-copy-owner.log.gz`.
- The desktop cleanup source/tests and migration source/tests match `origin/main` exactly. These failures are outside the controller conflict resolution.
- Firewall: `mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` retained the root-entrypoint deadline (33 passed, one failed, 45.1 s), receiving null subprocess status at 5002.30 ms; aggregate duration was 5052.60 ms. Evidence: `orkestrator-test-run.oRh7yw/merge-firewall-owner.log.gz`. The existing [0983](../environments-and-containers/0983-firewall-root-entrypoint-shell-timeout.md) remains open; this observation is not newly classified as flaky.

## Passing checks and scope

`mise run test:logged -- --name merge-check -- mise run check` passed formatting, lint and typechecks after formatting the resolved controller. Public-site browser validation passed separately (`mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts`, 10.5 s). All original conflicts were retained in parent-bound local Git metadata and checked for remaining markers. Dedicated real-stack, Docker, Electron and iOS scenario suites were outside this controller composition resolution; no isolated application profile was started.

## 0247 review follow-up (2026-10-27)

The later temp-directory cleanup review observed the same four assertions in
its full suite (35,493 passed, six failed, 204 not run). The complete owners
were rerun unchanged on the 0247 branch and in a detached checkout of its diff
merge base, `ce205ad34b9e157ad22eb866b1d159ba6420c992`, on macOS arm64,
Bun 1.4.4. Installed dependencies were linked from the working checkout;
source and lockfiles were not changed.

- `previously-failing-copy`: 10 passed, two failed, 1.8 s. The merge-base
  `baseline-copy-merge-base` run also has 10 passed, two failed, 2.5 s;
  both missing-completion tests get extraction status `2` instead of `0`.
  Evidence: `orkestrator-test-run.oAbjef` and
  `orkestrator-test-run.aESxso` under the host temporary directory.
- `previously-failing-profiles`: 20 passed, two failed, 1.2 s. Both failures
  are the same extra `keychainWarning` field. Evidence:
  `orkestrator-test-run.qAFlEY`. The target-tip `9791a4254` checkout also
  reproduces both (20 passed, two failed; `orkestrator-test-run.UJbmXu`);
  `baseline-profiles-merge-base` also has 20 passed, two failed, 1.1 s
  (`orkestrator-test-run.LfaBUk`).
- Each command uses `mise run test:logged -- --name <label> -- bun test
  --cwd <checkout-or-package> <explicit-owner-path> --parallel=1 --only-failures`;
  desktop runs additionally preload `../../tests/setup-node.ts`.
- These are confirmed baseline failures, not flakes: neither owner passes
  alone on this host. Their causes are not established here. No assertions,
  deadlines, skips or implementations in these owners were changed.

The other two failures from that captured run are tracked separately:
[0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md)
and [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md).

The final `review-full` run in this follow-up also retained all four baseline
assertions. Overall it had 35,509 passed, 12 failed, 199 skipped and four
between-test errors, exit 1 in 711.7 s. The remaining failures are registered
Git/environment deadline cases (0248, 0291, 0621, 0957 and the new 1107).
Evidence: `orkestrator-test-run.TZNWYO/summary.json` and its compressed group
logs; the enclosing logged command is `orkestrator-test-run.DCQCrJ`.

## Latest main merge (2026-10-27)

Parents: `711de8869705b8672a214aeb4d82c408a055c2d0` and
`863b578217fca437c37c53372bec7a4f97719079`. The original conflict list is
retained in local Git metadata with both IDs: `commands-process-coverage.test.ts`,
the aggregate and environment group indexes, and the 0187 case. Resolution
keeps all XDG fixture isolation/restoration, main's Docker topology resets and
rootless fixture behavior, and both branches' documentation evidence.

`mise run test:logged -- --name merge-repository-tests -- mise run test`
exited 1 after 835.9 s (groups: 833.7 s), with standard workspace/root/bridge/
protocol reservations of 4/1/2/1 and two backend workers. No watchdog or
output limit fired. Evidence under the host temporary directory:
`orkestrator-test-run.2onpQ5/summary.json` and compressed group logs;
outer evidence: `orkestrator-test-run.sS14yL/merge-repository-tests.log.gz`.

- Backend: 12,072 passed, 120 skipped, 18 failed, six between-test errors,
  733 files. Desktop: 1,369 passed, 16 skipped, two failed. Root/support:
  3,531 passed, two failed. These groups remain non-green.
- Web (9,941 passed), protocol (1,939 passed, two skipped), CLI (329 passed),
  toolchain (91 passed), public web (41 passed), bridges and the Codex protocol
  lockfile check passed.
- Logged formatting, lint and typecheck commands (`merge-format`, `merge-lint`,
  `merge-typecheck`) passed. The conflicted backend owner passed its focused
  `merge-process-coverage` command (1.5 s) and had no failures in the aggregate.
  Documentation links and preservation of both parents' index entries were checked.

Each owning-file rerun used `mise run test:logged -- --name <label> -- bun test`
with the explicit path and `--parallel=1 --only-failures`; backend and desktop
owners also used the package working directory and
`--preload ../../tests/setup-node.ts`. None of these failing owners was manually
changed for this merge.

| Label | Owner | Result |
| --- | --- | --- |
| merge-migrate-copy-owner | `tests/unit/migrate-copy.test.ts` | 10 passed, two failed, 6.1 s; both extraction-status assertions still return 2 instead of 0. Evidence: `orkestrator-test-run.2TKxJE`. |
| merge-profile-cleanup-owner | `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 20 passed, two failed, 1.0 s; both unexpected `keychainWarning` fields persist. Evidence: `orkestrator-test-run.8sBil2`. |
| merge-staged-input-relay-owner | `apps/backend/tests/staged-input-relay.test.ts` | Five passed, four failed, 0.7 s; owner-only directory mode, stale relay removal, revoked mount contents and over-bound cleanup assertions persist. Evidence: `orkestrator-test-run.oU5GNU`. |
| merge-docker-image-owner | `apps/backend/tests/docker-image.test.ts` | 19 passed, two failed, 1.8 s; both expected host.docker.internal add-host arguments remain absent. Evidence: `orkestrator-test-run.IRyiZc`. |
| merge-environment-move-owner | `apps/backend/src/core/environment-move.test.ts` | 13 passed, 25 failed, 22 between-test errors, 278.1 s; deadlines and follow-on Git, removed-fixture and SQLite errors persist. Evidence: `orkestrator-test-run.TKZQvm`. |
| merge-commands-integration-owner | `apps/backend/tests/commands-integration.test.ts` | 53 passed, two failed, two errors, 70.9 s; artifact-excludes and scan-cache hook deadlines persist. Evidence: `orkestrator-test-run.kvc2CA`. |
| merge-worktree-location-owner | `apps/backend/src/core/commands-environment-worktree-location.test.ts` | Seven passed, two failed, one error, 25.5 s; start and alias-retarget deadlines persist, with SQLite follow-on errors. Evidence: `orkestrator-test-run.9TcLI4`. |
| merge-acceptance-sharing-owner | `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | 14 passed, one failed, one error, 25.5 s; V09 hook deadline and condition-not-reached error persist. Evidence: `orkestrator-test-run.RHqOyx`. |
| merge-worktree-watcher-owner | `apps/backend/tests/worktree-watcher.test.ts` | 33 passed, one failed, 3.7 s logged; real-file write still receives zero changes (2008.43 ms). Evidence: `orkestrator-test-run.tts7bt`. |
| merge-coordinator-owner | `apps/backend/src/core/coordinator-service.test.ts` | Passed, exit 0, 15.3 s; aggregate dirty-submodule deadline was 5113.39 ms. See 0945. |
| merge-environment-fork-owner | `apps/backend/tests/commands-environment-fork.test.ts` | Passed, exit 0, 3.5 s; aggregate local-fork deadline was 26779.98 ms. See 1105. |
| merge-worktree-snapshots-owner | `apps/backend/src/core/worktree-snapshots-git.test.ts` | Passed, exit 0, 6.1 s; aggregate unnamed hook deadline was 5000.79 ms. See 0957. |

Only the three owners that passed their reruns establish aggregate-only
recurrences in this run; their existing cases and indexes were updated.
All other results remain failures, not new flake classifications. Their causes
were not established, and no assertion, deadline or skip was changed. No new
renderer flow or lifecycle implementation was part of the resolution, so
additional browser, real Docker, Electron and iOS scenario suites were not run.
