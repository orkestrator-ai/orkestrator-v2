# Cross-machine search validation: workspace-group backend and desktop failures

- **ID:** 1126
- **Status:** open
- **Date observed:** 2026-10-27. The host was a macOS arm64 Mac (Darwin 27)
  with 18 logical cores and Bun 1.4.x, with many other worktrees active.
  `uptime` load averages during the owner reruns were 4 to 52.
- **Branch:** `search-projects-environments-d964ef18680e-r1` (PR #1327). It
  changes web search, the protocol node summaries and the backend read model
  that builds them. It does not change environment move, worktree location,
  worktree snapshots or watchers, the command registry, Docker image
  creation, the container entrypoints or the desktop profile tooling.
- **Target:** `origin/main` at `863b578217fca437c37c53372bec7a4f97719079`,
  checked out as a detached worktree with its own `bun install`.

## Runs

Two `mise run test` verifications of the branch failed in the workspace group.
The first listed 44 workspace failures and the second (at `2df7af3b6`) listed 32.
Every failure was in one of the ten owning files below. None of them is a
search, federation or summary test. Each owner was then rerun alone with
`bun test --preload ../../tests/setup-node.ts <file>`, from `apps/backend`
(`apps/desktop` for profile cleanup), on the branch and on `origin/main`.

| Owner | Branch alone | `origin/main` alone | Known case |
| --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Run 1: 33 pass, 5 fail. Run 2: 30 pass, 8 fail. The failing set differs between runs, and every failure is a 5 s deadline. The three nested-submodule cases and submodule restart recovery fail in both runs. | 34 pass, 4 fail in both the earlier verification and this rerun: the same nested-submodule and restart re-link timeouts. | [0201](../environments-and-containers/0201-move-submodule-fixture-index-lock.md), [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md), [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md), [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0695](../environments-and-containers/0695-environment-move-no-tmux-timeout.md), [0866](../environments-and-containers/0866-environment-move-interrupted-rename-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | Run 1: 2 pass, 2 fail. Run 2: 3 pass, 1 fail. All are 5 s watcher deadlines. | 3 pass, 1 fail (this rerun); 1 pass, 3 fail (earlier verification). | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [0947](../environments-and-containers/0947-worktree-git-aggregate-timeouts.md), [0957](../environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | 8 pass, 1 fail: `retargeting an accepted alias …` (5.9 s). | 8 pass, 1 fail: the same case (6.0 s). | none |
| `apps/backend/tests/worktree-watcher.test.ts` | 33 pass, 1 fail: `startWorktreeWatcher > observes a real file write` (2 s). | 33 pass, 1 fail: the same case. | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/backend/tests/commands-integration.test.ts` | 55 pass, 0 fail. | 55 pass, 0 fail (this rerun). In the earlier verification it had 53 pass, 2 fail, with timeouts of 8.5 s and 11.4 s. | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md) recurrence, aggregate only |
| `apps/backend/tests/commands-registry-environments.test.ts` | 68 pass, 0 fail. | 68 pass, 0 fail. | [0188](../environments-and-containers/0188-environment-worktree-aggregate-timeouts.md) recurrence, aggregate only |
| `apps/backend/tests/commands-environment-fork.test.ts` | 24 pass, 0 fail. | 24 pass, 0 fail. | aggregate only |
| `apps/backend/tests/staged-input-relay.test.ts` | 5 pass, 4 fail. | 5 pass, 4 fail, identical assertions. | Host dependence, not a flake: todo 0321, fixed in #1365 (see below) |
| `apps/backend/tests/docker-image.test.ts` | 19 pass, 2 fail (`pinned image identity` `--add-host` cases). | 19 pass, 2 fail, identical assertions. | Host dependence: todo 0321, fixed in #1365 |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 20 pass, 2 fail (an unexpected `keychainWarning`). | 20 pass, 2 fail, identical assertions. This was also recorded in [1013](1013-interactive-command-main-merge-validation.md). | Host dependence: todo 0321, fixed in #1365 |

The non-workspace failures from the same runs are recorded separately. The
migration-copy failures are in todo 0320. The Claude qualification deadlines
are in flake [1125](../agent-bridges/1125-claude-offline-cli-qualification-deadlines.md).
The firewall seed/live/cache timeout recurred as
[0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md).

## Assessment

- Three owners pass alone on both trees: command integration, the
  registry's environment lifecycle and environment fork. Their aggregate
  failures are load-sensitive deadlines, recurrences of the cases listed
  above.
- Four timeout owners also fail alone, on the branch and on `origin/main`
  alike: environment move (submodule cases), worktree snapshots, worktree
  location and the worktree watcher. They need real Git, real file events or
  submodule clones within 2 to 5 s deadlines. They are pre-existing on this host
  and are covered by the open cases above. The branch does not touch them.
- Three owners fail deterministically with identical assertions on both
  trees. Each has a demonstrated macOS cause, set out in todo 0321.

## Host-dependent owners resolved, 2026-10-28

The three host-dependent owners were made host-independent by #1365
(`beb1ec4c8`), and todo 0321 was closed. Now the relay test runs the
entrypoint with Homebrew's GNU tools first on `PATH`
(`tests/unit/gnu-shell-tools.ts`), so it needs the testing guide's macOS
prerequisites. The two `--add-host` cases simulate a Linux host, and the
profile-cleanup cases pass their temporary roots as `keychainRoots`. A re-run
on `main` at `1d1f0a878`, on a macOS arm64 host (Darwin 27) with GNU
coreutils and findutils installed, gave these results.
`staged-input-relay.test.ts` with `docker-image.test.ts` had 30 pass, 0 fail.
`profile-cleanup.test.ts` had 22 pass, 0 fail. The other seven owners in this
case are unchanged by that fix.

No test, deadline or implementation outside the search change was modified.

## Review-fix validation, 2026-10-27

The follow-up changes only search empty-state copy and regression coverage for
actual sidebar reveal wiring and legacy recency. No backend, desktop, migration,
transcript, or close-retention implementation changed.

- `mise run test:logged -- --name search-review-check -- mise run check`
  passed format, lint, and typecheck.
- `mise run test:logged -- --name search-review-focused -- bun test --cwd apps/web ./src/components/sidebar/ProjectSearchBar.test.tsx ./src/components/sidebar/ProjectSearchBar.federation.test.tsx ./src/components/sidebar/HierarchicalSidebar.search.test.tsx --parallel=2 --only-failures`
  passed. An initial invocation omitted `--cwd apps/web` and matched no files;
  the corrected invocation above is the validation evidence.
- `mise run test:logged -- --name search-review-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/ProjectSearchMachines.spec.ts --workers=2`
  passed all 18 desktop/mobile cases.
- `mise run test:logged -- --name search-review-suite -- mise run test`
  failed after 700.6 s. All 9,992 web tests passed (10 skipped); bridges and
  protocol regeneration passed. Backend had 11,484 passed, 106 skipped,
  20 failed; desktop had 1,369 passed, 16 skipped, two failed. Failing owners
  were environment-move, commands-registry-environments, commands-integration,
  worktree-snapshots-git, worktree-watcher, docker-image, staged-input-relay,
  and profile-cleanup: the owners already assessed above. These unchanged
  owners were not rerun again in this follow-up, so current load sensitivity
  is not independently established. Root failures were the two migrate-copy
  extraction-status assertions in todo 0320; a complete isolated owning-file
  rerun (`search-review-copy-owner`, `bun test ./tests/unit/migrate-copy.test.ts
  --parallel=1 --only-failures`) reproduced them: 10 passed, two failed.
- `mise run test:logged -- --name search-review-browser-suite -- mise run test:browser`
  failed after 420.4 s: 790 passed, 103 skipped, five failed. All search cases
  passed. Failures were the native branch suggestion in both viewports
  (expected `release/2.0`, received `rel`), mobile StreamingTranscript find
  convergence ([0767](../native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md)),
  mobile ToolGroupFold threshold geometry ([1012](../web-ui/1012-live-tool-fold-threshold-gap.md)),
  and desktop Cursor steering ([0963](../web-ui/0963-close-retention-cursor-cases-under-load.md)).
  Public-site browser tests were short-circuited by the component failure.
- Complete unchanged browser owners were rerun sequentially with
  `mise run test:logged -- --name search-review-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/StreamingTranscript.spec.ts e2e/ToolGroupFold.spec.ts e2e/CloseRetention.spec.ts --workers=1`:
  83 passed, 20 skipped, five failed (4.5 minutes). ToolGroupFold passed in
  both viewports, and the original find-convergence case passed. Both native
  branch suggestions and desktop Cursor steering still failed. Two different
  StreamingTranscript reflow cases failed: mobile detached-reader maximum
  anchor error was 91 px (limit 3), and desktop follower bottom distance was
  88 px (limit below 2). These reflow failures remain unclassified; the
  complete StreamingTranscript owner did not pass in this rerun.

Evidence under the host temporary directory: aggregate nested logs in
`orkestrator-test-run.lewQrh/`, outer summary in `orkestrator-test-run.o7E8I9/`,
component browser logs in `orkestrator-test-run.EZd1eB/`, browser-owner logs in
`orkestrator-test-run.IUUO8M/`, and migration-copy rerun in
`orkestrator-test-run.V2BD8C/`. No unrelated assertion, timeout, or skip changed.

### Isolated-stack follow-up

`mise run test:logged -- --name search-review-isolated -- mise run test:agent:browser:isolated`
completed after 538.9 s: 32 passed, 69 skipped, four failed. It ran the same
source content committed as `f3fe04e67` during the run. The failures were:

- `browser-gateway.spec.ts:609`, file rename: the expected existing-destination
  error message was not visible within five seconds.
- `browser-gateway.spec.ts:711`, capped file tree: `fresh.o` was not visible
  within 15 seconds.
- `browser-gateway.spec.ts:2366`, review queueing: status remained `pending`
  instead of `queued` within five seconds.
- `design-canvas.spec.ts:13`, cross-client edits: `Mock up the sidebar` was
  not visible within five seconds.

These unchanged owners were not rerun; the observations remain unclassified
and do not establish a green isolated-stack baseline. Live-provider and Docker
opt-ins remained disabled. The runner stopped and reset its exact profile,
`qa-browser-ad4d17ae-062`, and confirmed disposable profile state was removed.
Artifacts remain under `output/agent-testing/qa-browser-ad4d17ae-062/browser/`;
the bounded log is `orkestrator-test-run.WJGkIS/search-review-isolated.log.gz`
under the host temporary directory.

The updated failure-register indexes passed
`mise run test:logged -- --name search-review-flake-index -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures`.
Electron-native, Docker, CLI scenario, preview, and iOS suites were omitted
because the follow-up changes only search copy and renderer regression tests.
