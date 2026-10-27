# Orkestrator permission rules (todo 0723) branch validation

- **ID:** 1171
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `feature-clarification-18cad6211bd8-r1`, uncommitted on
  `727f91c8f`. The change adds `packages/protocol/src/permission-rules.ts`,
  `apps/backend/src/core/permission-rules/`, rule eligibility in the Codex,
  Claude, Pi and ACP bridges, web components, CLI commands and docs. None of
  the files below imports the changed code.
- **Command:** `mise run test` (logs `orkestrator-test-run.TgL2Ow` below the
  host temporary directory). The Codex protocol lockfile passed; the
  workspace, root/support and bridges groups exited 1.
- **Host:** the shared macOS host and owners-disabled external volume of
  [1170](1170-codex-saved-rules-0160-validation.md), with another
  worktree's `mise run test` running at the same time.

## Failures and what they are

Owners were rerun alone on the branch with `bun test <file>`. The base column
reran the same files in a temporary detached worktree at `727f91c8f` that
shares this worktree's `node_modules` (the change adds no dependency); the
worktree was removed afterwards.

| Owning file | Aggregate failures | Owner alone on the branch | Base `727f91c8f` alone | Registry |
| --- | --- | --- | --- | --- |
| `bridges/claude-bridge/src/services/session-manager-lifecycle.test.ts`, `session-manager-persistence.test.ts` | `a complete journal proves an unclaimed id absent…`, `reconcilePersistedSessions > restores journal completeness…` | 9 failed (`ReferenceError: sessionManagerTestHome is not defined`: both files use the harness export without importing it) | 9 failed, the same | Recorded here; a test-file defect, not a flake |
| `apps/backend/src/core/environment-move.test.ts`, `worktree-snapshots-git.test.ts`, `apps/backend/tests/docker-image.test.ts`, `staged-input-relay.test.ts`, `commands-registry-environments.test.ts` | Move, real-Git, pinned-image, staged-relay mode and fetched-base cases | 15 failed | 18 failed | 1170, 1101, 0957 |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 2 failed | 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed` | 2 failed | 2 failed | 1101, 1170 |
| `bridges/cursor-bridge/src/http.test.ts` | `authentication > reports an authenticated credential as ready` | Passed (77) | Not needed | [0182](../agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md) |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | `a worker that takes in newer target history is retargeted…` | Passed | Not needed | [1110](../coordinator-and-multi-review/1110-diff-stats-reset-baseline-deadline.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | Passed | Not needed | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `tests/unit/test-diagnostic-bounds.test.ts` | `never passes a DOM-producing query result directly to toBeNull` | Caused by this branch's new web tests; fixed in the same change, then passed | Not needed | Not a flake |

## Conclusion

No failing file is owned or reached by the 0723 change apart from the
diagnostics rule, which the branch's own tests broke and now pass. The
Claude session-manager, backend git/Docker/relay, profile-cleanup and
migrate-copy owners fail identically on the base. The Cursor, diff-stats and
worktree-watcher owners pass alone and match their existing cases.

## Review fixes, 2026-10-27

The permission-rule review fixes add provider path/rename/sandbox guards,
filesystem link checks, bounded offers, and an applied-with-warning result when
saving a remembered rule fails. Focused protocol, backend, bridge and web tests
pass, including command binding, service cleanup/refresh, projection reads,
container rule framing/truncation and added-account discovery. `mise run check`
passes.

`mise run test:logged -- --name permission-full-suite -- mise run test` finished
in 733 seconds with the same three failing groups. Evidence is retained at
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.JvBUB5`
(inner group logs and summary) and `orkestrator-test-run.EFIfop` (outer runner).
There are no failures in the permission-rule owners. Failures are in the two
Claude session-manager files above, migrate-copy, profile-cleanup,
environment-move, commands-integration, worktree-snapshots-git,
commands-environment-worktree-location, acceptance-sharing, docker-image and
staged-input-relay. The acceptance-sharing watcher timeout is also tracked in
[1160](1160-claude-runtime-tasks-0005-validation.md).

Standalone reruns retained these unrelated failures:

| Owner | Result | Failure artifact directory under the same host temporary root |
| --- | --- | --- |
| Claude persistence | 99 pass, 1 skip, 1 fail; missing `sessionManagerTestHome` | `orkestrator-test-run.aR9VUx` |
| Claude lifecycle | 38 pass, 1 fail; same missing import | `orkestrator-test-run.Cw0SNV` |
| migrate-copy | 10 pass, 2 fail; extract status 2 instead of 0 | `orkestrator-test-run.4KdW7Y` |
| profile-cleanup | 20 pass, 2 fail; macOS keychain warning field | `orkestrator-test-run.zyxxuX` |
| environment-move | 27 pass, 11 fail, 8 errors; timeouts and filesystem/SQLite errors | `orkestrator-test-run.3mk31U` |
| acceptance-sharing | 14 pass, 1 fail; watcher setup timeout | `orkestrator-test-run.lRVFDV` |

These reruns are not classified as new flakes: they still fail alone on this
host, and no unrelated implementation or assertion was changed to conceal them.

The new real-stack lifecycle test passed with the Settings test: **2 passed,
0 skipped, 0 flaky**, in 99 seconds. It used the real Claude bridge and an
isolated fixture worktree, created a rule from an approval card, switched to
another environment while the next request was automatically approved,
verified its transcript note, reloaded and reopened the environment, restarted
the entire profile, verified the persisted rule/use count/note, removed the
rule, and observed another pending approval for the same command.

Reproduction (start a disposable `dev:test --fixture --credential-source claude
--agent-platforms claude` profile first; this test restarts that profile):

```sh
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000 mise run test:logged -- \
  --name permission-live-final -- env \
  ORKESTRATOR_AGENT_TEST_PROFILE=permission-final-qa \
  ORKESTRATOR_AGENT_TEST_LIVE_PERMISSION_RULES=1 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/permission-rules.spec.ts
```

The passing browser report is
`output/agent-testing/permission-final-qa/browser/results.json`. Earlier fixture
failures (a command that Claude allowed without asking, an overly narrow
settled-phase assertion, navigation to the internal project-home record, and
selection after reload) were corrected before the passing run. The first
profile launch was also incorrectly put under a five-minute no-output test
watchdog; the final launch used the normal foreground profile supervisor.
Both disposable profiles (`permission-review-qa` and `permission-final-qa`)
were stopped and reset after validation. No Docker lifecycle or Electron-only
scenario suite was needed for these approval-rule changes.
