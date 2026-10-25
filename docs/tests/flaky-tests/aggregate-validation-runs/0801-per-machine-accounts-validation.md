# Per-machine accounts branch validation

- **ID:** 0801
- **Status:** open
- **Date observed:** 2026-10-25, macOS arm64 (18 cores), Bun 1.4.2.
- **Branch:** `todo-0722-per-machine-accounts-43dab4042230` on `ba7cc8d4`. It
  changes the accounts overview, the account store and its protocol types, a
  Cursor bridge test and a Codex probe script; no OpenCode, transcript
  artifact or Codex bridge code.

## Commands and outcomes

| Check | Result |
| --- | --- |
| `mise run format:check` | Passed. |
| `mise run lint` | Passed. |
| `mise run test:logged -- --name typecheck -- mise run typecheck` | Passed. |
| `mise run test:logged -- --name test -- mise run test` | Failed after 1107.8 s; all four groups completed. Host load average was about 59 on 18 cores during and after the run, with other worktrees active. |

| Package/group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| root | 3405 | 1 | 0 |
| @orkestrator/protocol | 1849 | 0 | 0 |
| @orkestrator/desktop | 1234 | 0 | 14 |
| @orkestrator/web-public | 41 | 0 | 0 |
| @orkestrator/toolchain | 91 | 0 | 0 |
| orkestrator (CLI) | 242 | 0 | 0 |
| @orkestrator/web | 9558 | 0 | 10 |
| @orkestrator/backend | 10790 | 5 | 79 |
| cursor-bridge | 792 | 0 | 0 |
| codex-bridge | 2356 | 1 | 40 |
| pi-bridge | 606 | 0 | 1 |
| claude-bridge | 1619 | 0 | 5 |
| acp-bridge | 669 | 0 | 3 |

## Failures and owner reruns

| Owner | Aggregate failure (duration) | Owner alone |
| --- | --- | --- |
| `tests/unit/test-diagnostic-bounds.test.ts` | never passes a DOM-producing query result directly to toBeNull | **A real failure from this branch**: its new tests used `queryBy…().toBeNull()`. Fixed with `expectDomAbsent`; the owner then passed (16 of 16). Not a flake. |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` | registers a research server and allows exactly its tools (40002.06 ms) | Passed. Already tracked as 0785 in coordinator-and-multi-review. |
| `apps/backend/src/core/opencode-host-start.test.ts` | a start that loses the database is retried and comes up (291.53 ms) | Passed. |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | executable document policy in chromium (5001.89 ms) | Passed (39 of 39, 201.1 s). |
| `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts` | streamed media in Chromium (5007.24 ms) | Passed. |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | the external watchdog ends a blocked render within the deadline and the browser is gone (5879.98 ms) | Passed. |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | two pre-plugin answers stay stale until late plugins are observed and confirmed | Intermittent alone as well; see 0791 and [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md). |

The four backend owners other than the OpenCode research one were rerun
together with `--parallel=1` (24 of 24 passed, 51.1 s), and the content-server
engines owner on its own. Every timeout sat at a five-second (or 40-second)
budget under host load; contention is the hypothesis, not a proven cause.


## Preferred-account review fixes — 2026-10-25

Validation used Bun 1.4.4 on the same branch. Focused accounts component,
client, protocol and backend tests pass, as do formatting, lint and repository
typechecking. The touched-file lint check has no warnings. The first default
suite's root/support group reported 3,405 passed and one failed in 373.9 s:
new component assertions again violated the bounded DOM-diagnostics convention.
They now use `expectDomAbsent`; the complete diagnostics owner passes (10.7 s)
and the corrected component/client owners pass (3.5 s). This was a test defect
introduced by this change, not a flake.

`mise run test:logged -- --name account-fixes-browser -- mise run test:browser`
ran 782 component cases with nine workers alongside the repository and isolated
application suites: 675 passed, 102 skipped and five failed (456.3 s).
The failing unchanged owners and their complete one-worker reruns were:

| Owner | Aggregate failure | Complete owner alone |
| --- | --- | --- |
| `e2e/AgentLaunchDialog.spec.ts` | Native branch suggestions retained `rel` instead of `release/2.0` in both viewports after five seconds. | Two passed, two failed (21.4 s); both suggestion failures reproduce. This is the existing native-popup limitation recorded in case 0493, not a newly confirmed flake. |
| `e2e/TerminalLinks.spec.ts` | Desktop Control and Meta OSC 8 readiness checks encountered two `osc-ready` elements instead of one, both still `false`. | Four passed (15.0 s); credible intermittent failure under aggregate load. |
| `e2e/VirtuosoFollow.spec.ts` | Desktop small-wheel follow decision retained `false` instead of `auto` after five seconds. | Two passed, two existing mobile skips (3.8 s); recurrence of case 0153. |

Each rerun used `mise run test:logged -- --name <label> -- bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts --workers=1 --output output/playwright/<owner-output>`.
Labels/output directories were `account-fixes-native-branch-owner` /
`accounts-branch-owner`, `account-fixes-terminal-links-owner` /
`accounts-terminal-owner`, and `account-fixes-follow-owner` /
`accounts-follow-owner`. No failing owner or implementation changed, and no
assertion, deadline or skip was relaxed. Host contention is a hypothesis for
the terminal/follow observations, not a proven cause. Original aggregate
and native-owner evidence remains under the host temporary directory in
`orkestrator-test-run.PDGvql/account-fixes-browser.log.gz` and
`orkestrator-test-run.SyD4f6/account-fixes-native-branch-owner.log.gz`.
The original aggregate exit remains failed; its failure prevented the chained
public-site browser command from running. The separate follow-up
`mise run test:logged -- --name account-fixes-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts`
passes (10.4 s).

`mise run test:logged -- --name account-fixes-isolated-browser -- mise run test:agent:browser:isolated`
passes (563.1 s), including real-backend account switching and reload checks;
the runner stopped and reset its disposable profile.

The initial default run finished in 803.2 s. Workspace, bridges and protocol
lockfile groups passed; only the corrected diagnostics finding failed in
root/support. In the final full rerun, the complete root/support group passes
(461.2 s), as do bridges and the protocol-lockfile check.

The final default run finished in 1,038.4 s, exit 1. Its only failures were
unchanged owners: `AgentNativeTab.commands.test.tsx` observed two projection
reads instead of one (1,916.22 ms; case 0722), and
`content-server.engines.test.ts` exceeded the Chromium document-policy
five-second budget (5,000.73 ms; the existing 0801 observation above).
The complete command-filter owner passes unchanged (1.6 s):
`mise run test:logged -- --name account-fixes-native-commands-owner -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures`.
Original evidence: host temporary directory
`orkestrator-test-run.VttjoZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No default-suite failure involved the preferred-account regression tests.

The complete real-backend accounts browser owner additionally passes all three
cases (21.1 s), including new 1280px and 390px checks of the absent preferred
login's Clear button, keyboard focus/Enter activation, persisted storage and a
page reload. It ran through `runIsolatedBrowser` with a temporary configuration
spreading `playwright.browser.config.ts` and selecting only
`agent-accounts.spec.ts`; label `account-fixes-clear-browser-verified`.
The temporary config was removed and the runner stopped/reset the profile.
To repeat with a disposable profile, use the documented `dev:test --fixture`
lifecycle and run
`mise run test:logged -- --name accounts-browser -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/agent-accounts.spec.ts --workers=1`.
Two earlier new mobile-test attempts timed out in test navigation (first the
missing tools-menu opener, then opening that menu after reload without selecting
the fixture project). The helper now selects the discovered fixture and uses
the existing bounded menu-hydration pattern; these were test setup defects,
not preference failures or newly classified flakes. The corrected complete
owner passed in two consecutive runs (22.5 s and 21.1 s). Final full static
checks and the new e2e file's warning-free lint check pass.

The complete unchanged Chromium document-policy owner also passes (103.4 s):
`mise run test:logged -- --name account-fixes-content-engine-owner -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures`.
Both final-default failures therefore reproduce the known aggregate-only
observations; the original default exit remains failed. The verified account
browser profile was `qa-browser-5f9c0d93-2df`, with three expected passes and no
skips, unexpected failures or retries. Its report remains at
`output/agent-testing/qa-browser-5f9c0d93-2df/browser/results.json`.
No iOS, Electron-only or opt-in Docker/provider qualification was required by
these preference/UI changes.
