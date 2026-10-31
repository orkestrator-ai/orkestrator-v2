# Session titles and history (todo 0006) branch validation

- **ID:** 1166
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0006-session-titles-and-history-dd982dac8857`, based on
  `origin/main` `863b57821`. The branch changes the backend title service and
  projection, the Codex, Claude and Cursor bridges, the resume dialog and docs;
  it does not touch Git, worktree, Docker, environment-move, migration-copy or
  dev-profile code.
- **Commands:** `mise run test:logged -- --name full-suite -- mise run test`
  (`orkestrator-test-run.1VVSwg` for the groups, `FOyDWT` for the wrapper).
  Codex protocol lockfile passed; root/support and bridges exited 1; the
  workspace group waited for worker slots (18/18 reserved by other sessions'
  suites) until the 30-minute group deadline killed the run. The workspace
  group was then run on its own with the same turbo command
  (`orkestrator-test-run.eaOfPP`, `--concurrency=2`) and the root group with
  `bun test ./tests --parallel=4 --only-failures` (`lbtDm1`).
- **Host:** shared macOS host with several other branches' suites running.
- **Branch defects found and fixed in the same change:**
  `tests/unit/docs/upgrade-agents-docs.test.ts` (runbook cited the removed
  `session-titles.ts`), `tests/unit/test-diagnostic-bounds.test.ts` (two new
  `queryBy… ).toBeNull()` assertions) and
  `packages/protocol/src/native-agent.test.ts` (new `actions.archive` bit).
  Each passes after the fix.

## Failures and what they are

Owner reruns: `bun test ./<file> --parallel=1` in the owning package on the
branch. `origin/main` runs used a detached `origin/main` worktree with the
branch's `node_modules` linked in (`/tmp/ork-0006/base`, since removed).

| Owning file | Failures | Owner alone on the branch | `origin/main` alone |
| --- | --- | --- | --- |
| `bridges/claude-bridge/src/conformance-*-live.test.ts` | All 13 live CLI cases aborted at ~17 s | 13 pass | not run |
| `apps/web/src/App.test.tsx` | `App Docker availability > keeps the first startup diagnostic when the confirming probe fails differently` (1.0 s) | 119 pass | not run |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | `long transcript fixture > bounded concurrency …` (120.8 s) | 3 pass | not run |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | `typing after the sigil filters a maximal list …` (2.4 s) | 22 pass | not run |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` (5.4 s) | 36 pass | not run |
| `apps/backend/src/core/design/lifecycle.test.ts` | `the recycle bin is bounded by count and retention age` (5.0 s) | 28 pass | not run |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init > initializes a local repository …` (9.7 s) | 11 pass | not run |
| `apps/backend/src/core/review-validation-worker.test.ts` | `cooperative parallel groups do not multiply queue or execution deadlines` (2.0 s) | 50 pass | not run |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `executable document policy in firefox` (5.0 s) | 39 pass | not run |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule moves, failed re-link, restart re-link, move failure boundaries (five-second deadlines) | 38 pass (`--timeout 60000`) | not run |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | Explicit/configured roots; alias retarget (five-second deadlines) | 8 pass, 1 fail | 7 pass, 2 fail |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner` (five-second deadlines) | 0 pass, 1 fail | 1 pass, 4 fail |
| `apps/backend/tests/commands-integration.test.ts` | Git excludes, diff-statistics scan caches (8–16 s) | 52 pass, 3 fail | 53 pass, 2 fail; 1 fail on a second run |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity` (two cases) | 19 pass, 2 fail | 19 pass, 2 fail |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases | 5 pass, 4 fail | 5 pass, 4 fail |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | 33 pass, 1 fail | 33 pass, 1 fail |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | `pruneProfiles` age rule and outside-repository worktrees | 20 pass, 2 fail | 20 pass, 2 fail |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper` missing listing/root completion | 10 pass, 2 fail | 10 pass, 2 fail |

The first group are flakes on this host (fail in the aggregate, pass alone);
the Claude live CLI cases have their own case
([1165](../agent-bridges/1165-claude-live-cli-qualification-aggregate-timeouts.md)),
and the long-fixture, sigil-filter, parallel-group, Firefox-policy and
nested-submodule cases already have cases in their groups. The second group
fails on `origin/main` too, alone, on this host, matching
[1101](1101-codex-typed-prompts-0211-validation.md); none is caused by this
branch.

## Structured review fixes — 2026-10-31

The six findings and coverage gaps are addressed: delayed picker restores are
invalidated by a newer choice or close cycle, Cursor archive/adoption admission
is mutually exclusive, live and archived history have independent 512-row
quotas, Codex responses have independent 900 KiB category budgets and 512-character
titles, invalid stored title policies become `off`, and the optional pinned
Codex parser probe skips without its executable.

Targeted backend, web, Cursor, Codex and protocol regressions passed. All five
affected packages passed typechecking; changed TypeScript files passed formatting
and lint. The real pinned Codex parser and offline loopback title runner passed
without a model call, after downloading the pinned executable. The initial
backend-focused run also passed before that download.

`mise run test:logged -- --name review-full-suite -- mise run test` exited 1 after
871.7 seconds. Backend passed (11,712 passed, 103 skipped), along with desktop,
protocol, web-public, CLI, toolchain and protocol-lockfile checks. Web had 10,879
passed, ten skipped and two failures; root had 3,310 passed and one failure.

| Owner | Observation and disposition |
| --- | --- |
| `bridges/codex-bridge/src/app-server-runtime-sessions.test.ts` | Four explicit-title cases caught an initial 256-character listing truncation. Fixed the bound to the established 512-character contract; complete owning file passed with the archive and tail owners (`review-codex-size-and-titles`, 5.1 s). |
| `bridges/codex-bridge/src/app-server-runtime-archive.test.ts` | The initial stress fixture exceeded five seconds under aggregate load. Reduced its input from 20,000 to 1,024 characters per title while retaining thousands of rows and added a separate worst-case JSON-escaping budget check. Both owner and combined regression run passed. |
| `bridges/codex-bridge/src/runtime-env.test.ts` | Known 15-second timeout; unchanged owner passed alone (0.6 s), tracked in case 0093. |
| `tests/unit/disk-report.test.ts` | Known five-second timeout; unchanged owner still timed out (nine passed, one failed, one error), recorded in case 0259 without claiming a new isolated pass. |
| `apps/web/src/components/settings/machine-sign-in-routing.test.tsx` | Unchanged owner passed alone (2.6 s), case 1321. |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Unchanged owner passed alone (7.3 s), recurrence recorded in case 1313. |
| `apps/backend/tests/container-readiness.test.ts` | Preparation's early-probe count failure passed in the unchanged complete owner (6.9 s), case 1461. |

Evidence is retained in `orkestrator-test-run.oNZxqS` (aggregate groups) and
`orkestrator-test-run.6PffaS` (wrapper), under the host temporary directory.

An additional slow-tier diagnostic guard (`review-root-guards`) failed on 26
pre-existing files with unsafe DOM absence assertions. A scanner comparison
against `HEAD` verified that neither changed web test adds an unsafe assertion
(`review-changed-diagnostic-audit`, exit 0). The flake-index owner passed.
This audit failure is separate from the default test tier.

The corrected complete Codex bridge package then passed:
`mise run test:logged -- --name review-codex-package -- sh -c 'cd bridges/codex-bridge && bun run test:bridge'`
(exit 0, 97.5 seconds).

`mise run test:logged -- --name review-browser -- mise run test:browser` completed
its component suite with 983 passed, 106 skipped and 11 failures in 20.4 minutes;
the public-site step did not execute after that failure. All four native resume
picker cases passed (two scenarios at both viewport sizes).

The unchanged browser owners and picker were rerun with one worker:

```sh
mise run test:logged -- --name review-browser-failed-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/NativeResumeSession.spec.ts e2e/ClaudeInteractions.spec.ts e2e/DesignCanvas.spec.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/GlobalSettings.spec.ts e2e/PipelineFlow.spec.ts e2e/AgentLaunchDialog.spec.ts e2e/StreamingTranscript.spec.ts e2e/ToolGroupFold.spec.ts --workers=1
```

Result: 147 passed, three skipped and two failed in 5.9 minutes. Both remaining
failures were `selects a native branch suggestion with the keyboard and confirms`
in `AgentLaunchDialog.spec.ts`, at mobile and desktop viewports. That owner
retains its earlier native branch-picker failure (see cases 0822, 0958, 1251 and
1323); it is not newly classified as flaky. Claude interaction reload, design
canvas, environment drawer, global settings, pipeline reload, transcript find
and growing tool-group failures passed in these unchanged complete owning files
(known recurrences include cases 0252, 0174, 0278, 0767 and 0793). The data-saving
gateway owner was run separately.

Browser failure evidence: `orkestrator-test-run.MA9mVk/review-browser.log.gz`
(aggregate) and `orkestrator-test-run.3xOaJv/review-browser-failed-owners.log.gz`
(one-worker owners), under the host temporary directory. Browser traces were
written under `output/playwright/test-results/`; owner runs reuse that directory.

The complete data-saving gateway owner passed separately:
`mise run test:logged -- --name review-data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1`
(exit 0, 34.3 seconds; recurrence in case 1310).

### Final exact default-suite retry

`mise run test:logged -- --name review-full-suite-retry -- mise run test` was
launched after the listing bound was corrected. It waited 1,296.6 seconds for
host capacity, then ran all four groups. The full bridge group and Codex
protocol check passed. Root reported 3,310 passed, one failed and one between-test
error: the same unchanged disk-report owner timed out at 5,049.40 ms (case 0259).
The wrapper reached its 1,800-second deadline and terminated the unfinished
workspace group; the final retry is incomplete, not a passing full-suite result.

Evidence: `orkestrator-test-run.J36lvj/review-full-suite-retry.log.gz` (wrapper)
and `orkestrator-test-run.NyF4PB/` (group logs), under the host temporary directory.
All validation commands have exited. No application profile was started, and no
fixture server remained listening on port 1422 after browser validation.
Implementation and regression fixes are committed as `3aaa072d7`.
