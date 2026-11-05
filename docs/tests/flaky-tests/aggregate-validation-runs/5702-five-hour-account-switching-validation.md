# Five-hour account switching branch validation

- **ID:** 5702
- **Status:** open
- **Date observed:** 2026-11-05
- **Branch:** `auto-switching-window-b27fbfabc033-r1` at `e480b72d0`, on merge base `00948752f`.
- **Original command:** `mise run test`, run by review validation with the package-configured workers. The exact worker grant is not in the review package.
- **Duration and counts:** the suite took 3527.5 s and exceeded the 1,800,000 ms group deadline, so Bun printed no closing summary and has no total counts. The triage lists 60 failures: 51 in 15 named owner files and 9 with no file named.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-0db88652-dc4d-4555-a3b6-e9dc66c31b65/validation-04.stdout.txt`, in that worktree.

The triage marked 21 of the failures `related`, each with the reason
`imports-changed-file`. That reason records an import path, not a cause. The
branch's edits to `packages/protocol/src/multi-review.ts` and
`packages/protocol/src/review-fanout.ts` change comments only, and none of the
seven `related` owners names `agent-account-auto-switch`, `multi-review` or
`review-fanout`.

Rerun alone at `81346e6fb` (the same branch rebased on `af2e566e5`, with the
later switching commits), one worker each, through `mise run test:logged` with
`bun test <owner> --parallel=1 --only-failures`. Host load average was about 12
at the start of this batch and 3.6 near its end.

| Owner | Recorded failure | Alone |
| --- | --- | --- |
| `tests/unit/workspace-setup-preserve.test.ts` (5) | Null subprocess status at the 5 s deadline | Pass, 6.5 s |
| `apps/backend/tests/container-readiness.test.ts` (2) | 1586.95 ms against a 1500 ms bound; a renewed wait failed at 3573.76 ms | Pass, 4.9 s |
| `apps/backend/tests/portable-inputs-stamps.test.ts` (8) | Entrypoint boots hit the 60 s deadline | Pass, 128.3 s |
| `apps/backend/tests/portable-inputs-user-extensions.test.ts` (2) | Null subprocess status at the 5 s deadline | Pass, 2.0 s |
| `apps/backend/tests/claude-state-signal-integration.test.ts` (1) | `working 5 0` where `working 20 0` was expected. See [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md) | Pass, 0.4 s |
| `apps/backend/tests/commands-container-exec.test.ts` (1) | Credential helper check timed out at 5 s | Pass, 2.4 s |
| `packages/cli/tests/command-surface.test.ts` (2) | Shell completion timed out at 5 s | Pass, 1.3 s |
| `tests/unit/workspace-setup-git-mirror.test.ts` (14) | `git push` and hook timeouts at 5 s | Pass, 7.6 s |
| `tests/unit/container-account-markers.test.ts` (1) | Timed out at 5 s | Pass, 0.2 s |
| `apps/backend/tests/staged-input-relay.test.ts` (5) | Timed out at 5 s | Pass, 0.8 s |
| `apps/backend/src/core/shell-process-state.test.ts` (1) | Expected `false`, got `true`, at 403.40 ms | Pass, 1.0 s |
| `apps/desktop/scripts/dev/fixture.test.ts` (6) | Timed out at 5 s | Pass, 4.3 s |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` (2) | Timed out at 5 s | Pass, 0.9 s |
| `apps/backend/src/core/commands-files-local-scan.test.ts` (1) | Timed out at 5 s | Pass, 2.4 s |
| `apps/backend/src/core/coordinator-mail-attachments.test.ts` (1) | Timed out at 5 s | Pass, 2.6 s |
| `apps/backend/src/core/change-tracking/measurement-file-cap.test.ts` (1) | Timed out at 5 s | Pass, 2.2 s |
| `apps/web/src/components/chat/NativeResumeSessionDialog.test.tsx` (1) | Timed out at 5 s | Pass, 3.4 s |

The next aggregate, started at 11:20 UTC on the same branch, finished its
workspace group in 587.9 s. Backend 15,501 passed and 0 failed, web 12,551
passed and 0 failed, desktop 1,775 passed and 0 failed, CLI 475 passed and 0
failed. None of the owners above failed in it.

Four more 5 s timeouts have no located owner and were not rerun alone:
`cleanup after failed container start removes only successfully created
resources`, `stop_worker_turn > an idle tab answers plainly, and nothing is
marked or stopped`, `git fsmonitor > project-home status auto-starts and
preserves the configured daemon` and `reset and orphan prune preserve linked
worktrees without external ownership`. None failed in that next aggregate.

**Hypothesis:** host load slowed real `git`, shell and entrypoint subprocesses
past their deadlines: the same owners passed in the next aggregate, which took
about a sixth as long. Not established, because the original run recorded no
host load. Next recurrence: record load and the subprocess's own duration.

These are not flakes and stay out of this case:

- `packages/protocol/src/node/standalone-service-install.test.ts`, `a release without a published lockfile still installs, resolving afresh`: fails alone too (`node_modules/leaf/package.json` is absent), in a file this branch does not change.
- `tests/unit/flaky-tests-index.test.ts`: the case 4312 and 5701 files lacked their ID lines, which is a register defect rather than a timing failure.

No assertion, timeout or skip changed in any owner.
