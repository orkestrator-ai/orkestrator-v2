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
