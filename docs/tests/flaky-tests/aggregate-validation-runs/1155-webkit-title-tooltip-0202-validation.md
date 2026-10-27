# WebKit title tooltip (todo 0202) branch validation

- **ID:** 1155
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0202-webkit-title-tooltip-tap-ed0f7c01042b`, based on
  `origin/main` `863b57821`. The branch changes only
  `apps/web/src/components/layout/MobileAppShellLayout.tsx`, its unit test,
  `e2e/MobileAppShellLayout.spec.ts` and docs. `apps/backend`,
  `apps/desktop` and `tests` are identical to `origin/main`.
- **Host:** shared macOS host (Apple Silicon); other worktrees' suites were
  running.

## Full suite

`mise run test:logged -- --name full-test -- mise run test`: exit 1, 737.7 s
(groups `orkestrator-test-run.7Lgvkg` below the host temporary directory).
Bridges and the Codex protocol lockfile passed. Web passed (9,942 passed, 0
failed), as did web-public, CLI, protocol and toolchain. Backend, desktop
and root/support failed.

Every owner was rerun unchanged, alone, with one worker:
`bun test --preload ../../tests/setup-node.ts <file> --parallel=1` from the
package for backend and desktop, and `bun test ./<file> --parallel=1` at the
root. The same five files were then run the same way in a detached
`origin/main` worktree at `863b57821` (`/tmp/ork0202-main`, since removed).

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases (relay directory `0755` not `0700`, earlier relay kept, emptied mount still relayed) | 5 passed, 4 failed, deterministic | 5 passed, 4 failed | New todo [0350](../../../todo/containers-and-environments/0350-rootless-tests-fail-on-macos.md) (macOS host tools) |
| `apps/backend/tests/docker-image.test.ts` | Two `pinned image identity` cases expecting `--add-host host.docker.internal:…` | 19 passed, 2 failed, deterministic | 19 passed, 2 failed | New todo [0350](../../../todo/containers-and-environments/0350-rootless-tests-fail-on-macos.md) (reachability is Linux-only) |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 20 passed, 2 failed, deterministic | 20 passed, 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) (macOS only) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed` (extraction status 2, not 0) | 10 passed, 2 failed, deterministic | 10 passed, 2 failed | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `tests/unit/firewall-policy.test.ts` | `the root entrypoint runs the firewall itself and records the outcome per mode` (five-second deadline) | 28 passed, 6 failed (blocked-probe choices, GitHub range seed, root entrypoint) | 27 passed, 7 failed | [0983](../environments-and-containers/0983-firewall-root-entrypoint-shell-timeout.md), [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md), [1013](1013-interactive-command-main-merge-validation.md) |

## Component browser suite

`ORKESTRATOR_E2E_PORT=1532 mise run test:logged -- --name browser -- mise run test:browser`:
exit 1, 8.3 min, nine workers. 774 passed, 103 skipped, three failed
(`orkestrator-test-run.vZbTPL`). Both `MobileAppShellLayout` projects passed.

| Owning file | Failure | Owner alone | Registry |
| --- | --- | --- | --- |
| `e2e/AgentLaunchDialog.spec.ts` | `selects a native branch suggestion with the keyboard and confirms` (both projects): the branch input never took `release/2.0` | 2 passed, 2 failed, deterministic | Native datalist popup needs the Chrome channel in a graphical session (testing guide, "Native browser controls"); also in [0958](0958-transcript-scroll-review-validation.md) and [1013](1013-interactive-command-main-merge-validation.md) |
| `e2e/ToolGroupFold.spec.ts` | Mobile `a waiting group that fits its cap follows appended calls as it starts overflowing`: scrollTop 704, not 0 | Passed (23.9 s) | [0747](../web-ui/0747-tool-group-overflow-follow.md), recurrence appended |

The public-site suite, skipped after the component failure, passed on its
own: `mise run test:logged -- --name public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts`.

## Conclusion

The branch reaches none of these owners. Every non-browser failure
reproduces alone and on `origin/main` at the base commit. These are host
failures on macOS, not flakes, and stay with their owners (0350 is new for
the two rootless test files). The only intermittent failure is ToolGroupFold
(0747). No assertion, deadline, skip or implementation outside the branch's
scope was changed.


## Coverage review validation — 2026-10-27

Starting head: `d5f1d65d5`. The review adds CI wiring and a fixture click-through probe alongside the component and test changes.

- **Date observed:** 2026-10-27
- **Scope:** Touch/pen title-tooltip dismissal, its browser regressions and CI wiring. No failing owner below was modified.
- **Original commands:** `mise run test:logged -- --name repository-tests -- mise run test`; `ORKESTRATOR_E2E_PORT=15369 mise run test:logged -- --name component-browser -- mise run test:browser`; `mise run test:agent:browser:isolated`.
- **Worker configuration:** Repository workspace four slots (two package tasks with up to two Bun workers), root/support one, bridges two, protocol one; component Playwright nine workers; application Playwright one worker. Other worktrees were validating concurrently.
- **Component counts:** 775 passed, 105 skipped, four failed in 680.4 seconds. Both native branch suggestion cases, desktop Cursor steering with full history, and desktop small-wheel follow failed. Every mobile-shell case passed.
- **Repository result:** exit 1 in 1115.0 seconds. Web passed 9,943 tests with ten skips and no failures; bridges and Codex protocol verification passed. Backend retained eight failures (12,044 passed, 120 skipped), desktop two (1,369 passed, 16 skipped), CLI one (327 passed, one skipped), and root/support eleven plus one unhandled assertion (3,517 passed). All failing owning files were rerun unchanged; results are below. Wrapper evidence is `orkestrator-test-run.7AJEXR` and group evidence is `orkestrator-test-run.bJSskQ`.
- **Application counts:** 35 passed, 70 skipped, one failed in 12.2 minutes. The capped-file-tree reload could not find the `build` folder. Teardown separately rejected the trace at the 16 MiB sanitization bound. The disposable profile `qa-browser-689a17b1-1df` was stopped/reset and its directory was confirmed absent.

### Confirmed intermittent results

- `packages/cli/tests/fix-command.test.ts`: `live child suppresses parent SIGINT, receives termination signals, and releases listeners` timed out after 5024.32 ms in the repository suite. `mise run test:logged -- --name cli-fix-owner -- bun test --cwd packages/cli ./tests/fix-command.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 10.0 seconds. This confirms an intermittent deadline failure; concurrent host load is a hypothesis, not an established root cause.
- `e2e/VirtuosoFollow.spec.ts`: the desktop small-wheel case expected `auto` but retained `false` at five seconds. `ORKESTRATOR_E2E_PORT=15372 mise run test:logged -- --name virtuoso-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1` passed the complete unchanged owner in 9.5 seconds. This repeats [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md).
- `apps/backend/src/core/pty.test.ts`: terminal resize read `24 80` instead of `31 93` (46.53 ms). `mise run test:logged -- --name pty-owner -- bun test --cwd apps/backend ./src/core/pty.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 0.1 seconds. This repeats [0481](../backend-services-and-tooling/0481-pty-resize-before-stty.md).

### Failures retained in owning-file reruns

- `e2e/CloseRetention.spec.ts`: 17 passed, 20 skipped, three failed (148.5 s). Desktop Cursor session replacement, close/resume, and full-steer-history cases failed, including the original aggregate failure. Command: `ORKESTRATOR_E2E_PORT=15371 mise run test:logged -- --name retention-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --workers=1`. Evidence: `orkestrator-test-run.Fsp5Es`; no new flaky classification is established by this non-green owner.
- Root `firewall-policy.test.ts`: 25 passed, nine five-second deadlines failed (98.0 s). `migrate-copy.test.ts`: ten passed, two extraction-status mismatches failed (4.0 s). `disk-report.test.ts`: seven passed, one five-second deadline failed, with one unhandled assertion (6.2 s). Each ran separately with `mise run test:logged -- --name <owner> -- bun test ./tests/unit/<owner>.test.ts --parallel=1 --only-failures`.
- `apps/desktop/scripts/dev/profile-cleanup.test.ts`: 20 passed, two unexpected `keychainWarning` properties failed (1.4 s), matching [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md). Command: `mise run test:logged -- --name profile-cleanup-owner -- bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1 --only-failures`.
- `apps/backend/tests/docker-image.test.ts`: 19 passed, the same two host-address expectations failed (4.1 s), repeating the macOS failures already compared with the base above. Command: `mise run test:logged -- --name docker-image-owner -- bun test --cwd apps/backend ./tests/docker-image.test.ts --parallel=1 --only-failures`. Evidence: `orkestrator-test-run.1r0AKe`.
- `apps/backend/tests/staged-input-relay.test.ts`: five passed, the same four relay permission/removal expectations failed (0.4 s), repeating the macOS failures already compared with the base above. Command: `mise run test:logged -- --name staged-input-owner -- bun test --cwd apps/backend ./tests/staged-input-relay.test.ts --parallel=1 --only-failures`. Evidence: `orkestrator-test-run.g7Al8f`.
- `apps/backend/src/core/review-validation-worker.test.ts`: 49 passed, cooperative parallel-group completion remained `incomplete` instead of `passed` (45.5 s), matching [0227](../coordinator-and-multi-review/0227-validation-cooperative-groups-incomplete.md). Command: `mise run test:logged -- --name validation-worker-owner -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures`.
- `e2e/AgentLaunchDialog.spec.ts`: both native branch suggestion cases again retained `rel` instead of `release/2.0`; two other cases passed (30.7 s). Command: `ORKESTRATOR_E2E_PORT=15370 mise run test:logged -- --name branch-picker-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`.
- `e2e/agent-testing/browser-gateway.spec.ts`: fresh credential-free Codex fixture `tooltip-gateway-owner-1027` retained capped-tree timeout and narrow maintenance failures: 12 passed, 11 skipped, two failed (322.5 s), plus the trace-size teardown refusal. Command: `ORKESTRATOR_AGENT_TEST_PROFILE=tooltip-gateway-owner-1027 ORKESTRATOR_AGENT_TEST_RUN_ID=tooltip-gateway-owner-1027 ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`. The profile was stopped/reset with `dev:stop` and `dev:reset`, and its directory was confirmed absent. This adds no flaky classification for the gateway failures; see [0494](../previews-annotations-and-gateway/0494-gateway-picker-diff-and-fixture-visibility.md).

### Evidence

Compressed logs beneath the host temporary directory: component run `orkestrator-test-run.DTrkVE`, root/workspace groups `orkestrator-test-run.bJSskQ`, gateway owner `orkestrator-test-run.4Gpi2e`, firewall owner `orkestrator-test-run.vAmrps`, migration owner `orkestrator-test-run.oPNDVh`, disk-report owner `orkestrator-test-run.69pULu`, profile-cleanup owner `orkestrator-test-run.RIYEQs`, validation-worker owner `orkestrator-test-run.mZWUOD`, and native branch owner `orkestrator-test-run.w828s4`. Sanitized application evidence is under `output/agent-testing/<profile>/browser/`; the oversized trace was rejected rather than retained unsanitized.

No assertion, timeout, skip, or unrelated implementation was changed to mask these results. Static checks, the focused unit owner, and both Chromium and WebKit mobile-shell qualification passed.
