# Codex typed prompts (todo 0211) branch validation

- **ID:** 1101
- **Status:** open
- **Date observed:** 2026-10-26
- **Branch:** `prompt-display-bug-7b20be78777d-r1` at `fdcb5345d`, based on
  `origin/main` `ce205ad34`. The branch changes only `bridges/codex-bridge`,
  `e2e/agent-testing` and docs; `apps/backend`, `apps/desktop`, `packages` and
  `tests` are identical to `origin/main`.
- **Command:** `mise run test` (logs `orkestrator-test-run.Y6HDo7` below the
  host temporary directory). Bridges and the Codex protocol lockfile passed
  (bridges 159.8 s); the workspace group and root/support group exited 1.
- **Host:** shared macOS host, 18 cores, load average 23–30 while the suite
  and the reruns below ran (other sessions' suites in parallel).

## Failures and what they are

Every owner rerun used
`mise run test:logged -- --name 0211-<label> -- bun test --cwd <package> <file> --parallel=1`
on the branch. The `origin/main` column is a detached `origin/main` worktree
(`/private/tmp/orkestrator-verify-main-94c2a263`, since removed): its full
`mise run test` (`orkestrator-test-run.PofpIi`) and focused owner runs
(`g52w2w`, `Rz6D9p`, `M8k3bU`, `MHvg8P`, `Ks8uxh`).

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule moves (same disk, copy), failed submodule re-link, restart re-link, `rejected path commit clears the journal…` (both), Cursor read failure retention; five-second deadlines | 32 passed, 6 failed (all five-second deadlines), 110.2 s | Same deadline failures in the full suite and focused runs, `rejected path commit … (true)` included | [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md), [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md) (open). `rejected path commit` has no own case; recorded here. |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner`: tracked edit, linked-worktree staging, shared ref baseline; five-second deadlines | 2 passed, 2 failed (tracked edit, linked-worktree staging), 11.7 s | Same cases failed in the full suite and focused run | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md) (open); the staging and shared-ref cases recorded here. |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | passed, 1.0 s | Failed in the full suite and alone | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) (open) |
| `apps/backend/tests/commands-integration.test.ts` | `injects workspace artifact git excludes into local worktrees before status reads`, hook deadline at 13.4 s | passed, 28.7 s | Did not fail in the full suite or the focused rerun | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md), reopened as a recurrence |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases with an unexpected `keychainWarning` | 20 passed, 2 failed, deterministic | Same two fail | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) (macOS only) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed`: extraction status 2, not 0 | 10 passed, 2 failed, deterministic | Same two fail | [1013](1013-interactive-command-main-merge-validation.md) (retained alone there too) |

## Conclusion

None of these files is owned or reached by the 0211 change, and every one
except commands-integration fails the same way on `origin/main`. The
backend failures are five-second deadlines on real-Git fixtures under host
load; they reproduce on `origin/main` under the same load, so they are not
excused by isolation and stay open in their own cases. The profile-cleanup
and migrate-copy failures are deterministic on this macOS host and belong to
their owners. No assertion, deadline, skip or implementation was changed.


## Review-fix validation — 2026-10-27

The fix is based on `0c5da781c` on the same branch. It preserves matched empty
user rows, removes the unshipped JSONL fallback, and adds coverage for empty
recovered prompts, recovered context in plan mode, each metadata write failure,
and oversized current records. No backend, desktop, migration, gateway or test
runner implementation was changed.

- `mise run test:logged -- --name typed-prompts-regression -- bun test ./bridges/codex-bridge/src/sessions/typed-prompts.test.ts ./bridges/codex-bridge/src/history/rollout-typed-prompts.test.ts ./bridges/codex-bridge/src/app-server-runtime-typed-prompts.test.ts --parallel=3 --only-failures`: all 26 tests passed, 0.9 s.
- `mise run test:logged -- --name typed-prompts-static -- mise run check`: format, lint and typecheck passed, 3.1 s.
- `mise run test:logged -- --name typed-prompts-suite -- mise run test`: exit 1, 556.4 s. Standard workspace/root/bridges/protocol reservations were 4/1/2/1, with two backend workers, on the shared macOS host. Bridges passed in 138.9 s and the protocol lockfile passed. Backend had 11,435 passed, 101 skipped and 13 failed; desktop had 1,369 passed, 16 skipped and two failed; root/support had 3,526 passed and two failed. Web, web-public, CLI, protocol and toolchain passed. The two unrelated area suites were skipped by the import graph.
- Aggregate evidence: `orkestrator-test-run.rX0u3a` under the host temporary directory; outer bounded log `orkestrator-test-run.ZDiSxG/typed-prompts-suite.log.gz`. These are failed runs, not green qualification.

Every owner below was rerun unchanged through `mise run test:logged -- --name
<label> -- bun test <explicit file> --parallel=1 --only-failures`; backend
owners used `bun test --cwd apps/backend` and package-relative paths.

| Owner | Aggregate observation | Owner result |
| --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Nine timeouts: both nested-submodule moves, rejected-commit rollback, restart re-link, abandoned final copy, source cleanup, rejected path commit `(false)`, nonzero Git exit after rename, and cleanup retries preserving a new source directory. | `typed-prompts-move-owner`: 34 passed, four failed and four between-test errors, 72.3 s. Both nested moves, failed re-link and restart re-link still time out at five seconds; Git submodule errors accompany cancellation. Artifact `orkestrator-test-run.vvYtRP`. This owner remains non-green; load alone is not an established cause. |
| `apps/backend/tests/commands-integration.test.ts` | Artifact git-excludes injection (5012.79 ms) and enabling Git scan caches (6152.58 ms). | `typed-prompts-integration-owner`: complete owner passed, 26.3 s. Aggregate-only observations; see also [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md). |
| `apps/backend/tests/commands-registry-environments.test.ts` | Creating a local worktree from the fetched remote base branch (7149.64 ms). | `typed-prompts-environments-owner`: complete owner passed, 24.3 s. An aggregate-only observation in this run. |
| `apps/backend/tests/worktree-watcher.test.ts` | Zero observed changes after the bounded write loop (2011.66 ms). | `typed-prompts-watcher-owner`: complete owner passed, 2.7 s; recurrence of [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md). |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | The same two unexpected `keychainWarning` fields. | `typed-prompts-profile-cleanup-owner`: 20 passed, two failed, 0.9 s; artifact `orkestrator-test-run.SoQcV5`. |
| `tests/unit/migrate-copy.test.ts` | The same two extraction-status mismatches (`2`, expected `0`). | `typed-prompts-migrate-copy-owner`: 10 passed, two failed, 2.0 s; artifact `orkestrator-test-run.Uw5R9j`. |

### Browser observations

`mise run test:agent:browser:isolated` started credential-free Codex fixture
`qa-browser-7bf0a674-ae9`, one Playwright worker, alongside the aggregate. The
unchanged gateway file reported three failures: `real browser gateway exercises
an authoritative local environment` saw zero changed files at its 15 s deadline
(line 601); `capped file tree loads subtrees, retries failures and refreshes
across inactive views and reload` did not find `fresh.o` at its 15 s deadline
(line 836); and `review validation queues across worktrees and runs while its
environment is inactive` remained queued at its 5 s deadline (line 2436).

A fresh credential-free profile `typed-prompts-gateway-1027` reran those three
cases from `browser-gateway.spec.ts` with one worker:

`ORKESTRATOR_AGENT_TEST_PROFILE=typed-prompts-gateway-1027 ORKESTRATOR_AGENT_TEST_RUN_ID=typed-prompts-gateway-1027 mise run test:logged -- --name typed-prompts-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1 --grep 'real browser gateway exercises|capped file tree loads|review validation queues'`

Result: one passed, one failed, one skipped, 47.6 s, exit 1. The authoritative
local-environment case passed; the capped-tree case repeated the missing
`fresh.o` failure. The queue case skipped because this manual profile lacked
the private two-slot scheduler fixture, so it was not requalified. This was a
filtered owner rerun, not a complete owning-file pass. Evidence:
`orkestrator-test-run.UEKnCv/typed-prompts-gateway-owner.log.gz` under the host
temporary directory, and `output/agent-testing/typed-prompts-gateway-1027/browser/`.
The manual profile was stopped and reset. No assertion, deadline, skip or
implementation was changed to hide these failures. Live billed provider,
Docker, Electron-specific and iOS qualifications were not run for this bridge
replay fix.


The full isolated browser run reached its 900 s test deadline after starting
case 27 of 106 (persisted diff baselines), without a complete Playwright
summary. It exited 1 after 915.81 s including cleanup. The runner confirmed
`qa-browser-7bf0a674-ae9` was stopped and reset. Partial artifacts remain under
`output/agent-testing/qa-browser-7bf0a674-ae9/browser/`. The interrupted run
cannot establish how the remaining cases behave, and the skipped scheduler
case remains a coverage limitation. The typed-prompt live-provider spec was
not reached; the credential-free run does not opt into billed turns.
