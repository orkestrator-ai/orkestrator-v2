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
