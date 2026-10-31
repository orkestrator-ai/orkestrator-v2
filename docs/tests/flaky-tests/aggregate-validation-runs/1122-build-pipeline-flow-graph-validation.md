# Build pipeline flow graph branch validation

- **ID:** 1122
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `pipeline-flow-graph-d2d5436138ad-r1` at `e0c97e076`, which merges
  `origin/main` `863b57821`. The branch changes `apps/web` (build pipeline,
  flow graph, Multi Review), the build pipeline backend
  (`apps/backend/src/core/build-pipeline*`, `commands-registry-build.ts`),
  `packages/protocol/src/build-pipeline.ts`, `e2e/PipelineFlow*` and docs.
  None of the owners below is in the change.
- **Command:** `mise run test:logged -- --name flow-graph-full-test -- mise run test`,
  exit 1 after 1675.3 s (groups 1672.3 s). Group artifacts
  `orkestrator-test-run.GjFg1g` and the outer log `orkestrator-test-run.AAmDU9`,
  both below the host temporary directory.
- **Host:** shared macOS host, load average 100–205 throughout, with other
  sessions' suites running in parallel.

## Suite counts

| Group | Passed | Skipped | Failed |
| --- | --- | --- | --- |
| backend | 12,019 | 120 | 44 |
| desktop | 1,369 | 16 | 2 |
| web | 9,993 | 10 | 0 |
| protocol | 1,943 | 2 | 0 |
| web-public, toolchain, CLI | 41, 91, 329 | — | 0 |
| root and agent-support | 3,526 | — | 2 |
| claude-bridge | 1,703 | 6 | 3 |
| codex, acp, pi, cursor bridges | 2,441, 695, 651, 801 | 46, 3, 2, 0 | 0 |
| codex protocol lockfile | passed | | |

## Failures and what they are

Every owner was rerun unchanged and alone with
`mise exec -- bun test --preload <root>/tests/setup-node.ts --parallel=1 <file>`
from its package, first on the branch and then on a fresh clone of
`origin/main` `863b57821` under `/tmp/ork-main-compare.*` with its own
`bun install --frozen-lockfile` and no links into the build worktree.

| Owning file | Aggregate failures | Branch alone | `origin/main` alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | 26 move, recovery and rollback cases; 5–40 s deadlines | 34 passed, 4 failed (nested-submodule moves, re-link, restart re-link; Git `could not read IPC response`) | identical 4 failed | [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner`: tracked edit, linked-worktree staging, shared ref; five-second deadlines | 1 passed, 3 failed | identical 3 failed | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [0957](../environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | explicit and configured roots; alias retargeting | 7 passed, 2 failed | identical 2 failed | [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/commands-integration.test.ts` | artifact git excludes injection (16.8 s) | 54 passed, 1 failed (git excludes, 5 s) | 53 passed, 2 failed (git excludes and scan caches) | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md), [0162](../environments-and-containers/0162-electron-diff-statistics-aggregate-timeout.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write`, zero changes | 33 passed, 1 failed | identical 1 failed | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/backend/tests/docker-image.test.ts` | two `pinned image identity` cases expecting `--add-host host.docker.internal:…` | 19 passed, 2 failed, deterministic | identical 2 failed | Recorded here; fails the same on `origin/main` on this host. |
| `apps/backend/tests/staged-input-relay.test.ts` | four `staged input relay` cases (mode 0755 for 0700, expected rejections resolve) | 5 passed, 4 failed, deterministic | identical 4 failed | Recorded here; fails the same on `origin/main` on this host. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | two `pruneProfiles` cases with an unexpected `keychainWarning` | 20 passed, 2 failed | identical 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `a missing listing/root completion times out as extract-failed` | 10 passed, 2 failed | identical 2 failed | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/commands-environment-fork.test.ts` | `starts a local fork from the source commit rather than origin/main` (9.5 s) | 24 passed | not needed | aggregate-only, recorded here |
| `apps/backend/tests/commands-registry-environments.test.ts` | three local-worktree lifecycle cases (14–42 s) | 68 passed | not needed | aggregate-only, recorded here |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `Claude CLI execution policy qualification > network`, controller aborted at 15.6 s | 4 passed | not needed | aggregate-only, recorded here |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | `coordinator-sandbox-refuses`, `unavailable-hook-reads` (15–17 s) | 9 passed | not needed | aggregate-only, recorded here |

## Conclusion

Every failing owner is outside the change. Nine fail the same way alone on a
clean `origin/main` clone, so they predate this branch. The other four passed
alone, so they are aggregate timing failures under this host load. No
assertion, deadline, skip or implementation was changed.

## Review-fix validation — 2026-10-27

The review fixes are committed as `444667012`. Format, lint, typecheck, the
protocol and focused backend/web regressions passed. The final broad web run
passed **10,007 tests**, skipped 10 and failed none. The diagnostic-bounds owner
also passed after the new absence assertion was corrected.

- **Initial aggregate:** `mise run test:logged -- --name pipeline-repository-tests -- mise run test`, exit 1 after 823.7 s. Its backend group reported 12,052 passed, 120 skipped and 17 failed. Standard workspace/root/bridges/protocol reservations were 4/1/2/1 slots; backend ran with two workers. The component browser suite was also running on the shared host.
- **Intermittent watcher failure:** `startWorktreeWatcher > observes a real file write` reported zero changes after 2007.02 ms. `mise run test:logged -- --name unrelated-worktree-watcher-isolated -- bun test --cwd apps/backend ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed the unchanged complete owner in 4.3 s. This is another recurrence of [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md).
- **Intermittent shutdown failure:** `OrkestratorBackend > shuts down idempotently and rejects later command invocations` exceeded its five-second deadline (6035.48 ms), followed by disk-I/O errors from background reconciliation after fixture teardown. `mise run test:logged -- --name unrelated-backend-core-isolated -- bun test --cwd apps/backend ./tests/backend-core.test.ts --parallel=1 --only-failures` passed the unchanged complete owner in 4.3 s. Delayed shutdown under host contention is a hypothesis; the cause is unconfirmed.
- **Persistent owner failures:** separate single-file invocations with `--parallel=1` reproduced environment-move (8 passed, 30 failed, 27 between-test errors), profile cleanup (20 passed, 2 failed), migration-copy (10 passed, 2 failed), worktree Git (3 passed, 1 failed), worktree-location (7 passed, 2 failed, 1 between-test error), Docker image identity (19 passed, 2 failed), and staged-input relay (5 passed, 4 failed). These owners and their implementation were not changed by the review fixes.
- **Browser aggregate:** `mise run test:logged -- --name pipeline-browser-suite -- mise run test:browser` finished with 811 passed, 103 skipped and two failures, both `AgentLaunchDialog.spec.ts:18` native branch-suggestion selection (expected `release/2.0`, received `rel`). The full unchanged owner reproduced both failures with `--workers=1`. PipelineFlow, MultiReviewFlow and the new production split-pane focus scenario passed. The public-site browser suite, skipped by the failed chained command, was run separately and passed.
- **Evidence root:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`. Initial aggregate groups: `orkestrator-test-run.7MUQ6w`; enclosing log: `orkestrator-test-run.NTgZ3E`. Browser aggregate: `orkestrator-test-run.3pBsV4`; isolated native dialog: `orkestrator-test-run.AohqTn`. Persistent isolated owners: `orkestrator-test-run.r4dwNJ`, `orkestrator-test-run.WeMU3u`, `orkestrator-test-run.OpoQSM`, `orkestrator-test-run.wqQwjU`, `orkestrator-test-run.9FHzij`, `orkestrator-test-run.nJK7Oe`, `orkestrator-test-run.IR2rrg`, respectively. Failing logs are compressed; passing owner output was removed by the logged runner.

### Final stable-source aggregate

`mise run test:logged -- --name pipeline-final-repository-tests -- mise run test`
exited 1; its groups finished in 1052.3 s, including a 154.2 s scheduler wait
for the earlier workspace run. Web passed 10,007 tests, skipped 10 and failed
none. Protocol passed 1,944 and skipped two. Backend reported 12,012 passed,
120 skipped and 55 failed; desktop reported 1,369 passed, 16 skipped and two
failed; root/support reported 3,526 passed and two migration-copy failures.
Bridges, CLI, toolchain, web-public and the protocol-lockfile check passed.
No pipeline regression or command-wiring test failed.

The remaining backend failures include additional unchanged environment,
worktree, tmux, rename and storage-fixture owners with deadline and disk-I/O
errors. They were not all rerun independently, so this run does not classify
all 55 as flakes or establish their cause. Final group evidence is
`orkestrator-test-run.jGpDAB`; the enclosing log is
`orkestrator-test-run.fvkjWz`, below the evidence root above.

Live-provider, remote-node, real Docker/Electron and device scenario
qualification was not run: the changed behaviors were exercised through the
real UI with fixture backend state, backend service tests and protocol tests.

No assertion, timeout, skip or product code in any unrelated failing owner was
changed. The aggregate failures remain visible; passing owner reruns do not
turn a failed aggregate into a pass.

## Archived validation review repair, 2026-10-30

The repair is committed as `23bc3ed15`. Owning graph and inspector tests passed
(124 tests), service validation-history tests passed (10 tests), and all 58
PipelineFlow browser cases passed across phone and desktop widths, including
archived checks and the read-only Tests view before and after reload (76.8 s).
Affected web/backend/e2e type checks, changed-file lint and formatting passed.

Preparation had passed full format, lint and type checks. Its failed commands
were `mise run test` and `mise run test:browser`; their evidence remains under
`.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/`.
The unrelated owner follow-ups are:

| Owner | Preparation symptom | Complete isolated result | Case |
| --- | --- | --- | --- |
| `apps/backend/src/core/design/browser-profiles.test.ts` | Profile removed before its JSON ledger entry (265.62 ms) | Passed, 1.8 s | [1314](../design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md) |
| `apps/backend/src/core/storage-backups.test.ts` | Descendant still alive after bounded exit wait (2484.04 ms) | Passed, 3.0 s | [1317](../backend-services-and-tooling/1317-storage-backup-descendant-exit-race.md) |
| `tests/unit/disk-report.test.ts` | Five-second timeout, null report status (5166.47 ms) | Passed, 5.2 s | [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md) |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | First-answer settling timeout (2209.90 ms) | First isolated run: 29 passed, stale/ready assertion failed; second unchanged run: 30 passed, 1.2 s | [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md) |
| `e2e/ToolGroupFold.spec.ts` | Mobile fold gap 57 px instead of at most 2 px | 38 passed, 100.3 s | [1012](../web-ui/1012-live-tool-fold-threshold-gap.md) |
| `e2e/AgentLaunchDialog.spec.ts` | Native branch suggestion retained `rel` instead of `release/2.0` on both viewports | Two passed, two failed, 25.6 s | Persistent native picker behavior already recorded above |

The native-picker owner command was:

```sh
mise run test:logged -- --name recorded-native-branch -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1
```

Its compressed evidence is `orkestrator-test-run.RbCuhb/recorded-native-branch.log.gz`
below the host temporary directory. None of these owners or their product
implementations were changed. Passing isolated runs do not make the failed
preparation aggregates pass.

### Required full-command reruns

`mise run test:logged -- --name repaired-unit-suite -- mise run test` exited 1
in 1087.9 s, including about 629 s waiting for shared-host capacity. Root and
support passed (3,306 tests), all five bridge groups passed, and protocol
regeneration passed. Workspace failures were confined to four unchanged cases:

- Design profile ledger cleanup, [1314](../design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md), repeated at 266.79 ms.
- Desktop bridge startup, [1202](../electron-and-desktop/1202-bridge-build-startup-aggregate-timeout.md), hit its 15-second deadline; the complete owner passed alone in 1.2 s.
- Rich-content sibling ledger, [0626](../native-agents-and-transcripts/0626-rich-content-sibling-ledger-aggregate.md), observed zero rows instead of one; the complete owner passed alone in 1.9 s.
- Native activity batch sweep, [0247](../native-agents-and-transcripts/0247-activity-batch-sweep-no-requests.md), recorded no requests; the complete owner passed alone in 1.0 s.

Workspace totals: backend 11,271 passed / 87 skipped / two failed; web 10,845
passed / 10 skipped / one failed; desktop 1,363 passed / 16 skipped / one failed.
Protocol, CLI, toolchain and web-public passed. No pipeline test failed.
Outer evidence: `orkestrator-test-run.eHjonT/repaired-unit-suite.log.gz`; group
evidence: `orkestrator-test-run.jn7K1f/`, below the host temporary directory.

`mise run test:logged -- --name repaired-browser-suite -- mise run test:browser`
exited 1 in 764.2 s: 974 passed, 106 skipped and four failed. Both native picker
cases failed as in the complete isolated owner; desktop Cursor steer capacity
and Virtuoso scroll-follow also failed. All 58 PipelineFlow cases passed, and
the e2e type check passed. The chained public-site browser step was not reached.
Evidence: `orkestrator-test-run.CtuZX3/repaired-browser-suite.log.gz` below the
host temporary directory. The scroll-follow case observed `false` instead of
`auto` at line 43; Cursor saturation reported no running turn instead of
`steer-capacity-exceeded` at line 719.

The complete unchanged CloseRetention owner retained the steering failure, now
at the missing saturated-runtime card assertion: 19 passed, 20 skipped, one
failed, 136.3 s. No new isolated pass was established; see
[0963](../web-ui/0963-close-retention-cursor-cases-under-load.md). Its exact owner
command and compressed evidence are recorded there. No unrelated source,
assertions, timeouts or skips were changed.

The complete unchanged VirtuosoFollow owner passed with one worker, exit 0
in 5.4 s (two desktop cases and two mobile skips); see
[0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md).
Live-provider, Docker, Electron and device qualification were not run; the
changed pipeline behaviors were covered by unit/service tests and phone and
desktop fixture-browser cases.
