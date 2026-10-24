# Host picker (narrow): "Repository settings" never became visible after "Open tools" (`e2e/agent-testing/browser-gateway.spec.ts`)

- **ID:** 0224
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `host path browsing › host picker creates and browses folders through the authenticated gateway above fullscreen settings (narrow)`
- **Owning file:** `e2e/agent-testing/browser-gateway.spec.ts:147`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=d4538-shell bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-canvas.spec.ts e2e/agent-testing/browser-gateway.spec.ts e2e/agent-testing/native-draft-attachments.spec.ts --grep "design|private canvases|project Home|host picker|capped file tree|attachment" --workers=1`
  on a fresh `dev:test --fixture --no-agent-credentials --agent-platforms codex,opencode,cursor,grok`
  profile. This case ran second, straight after its desktop variant.
- **Failure:** `locator.click: Timeout 15000ms exceeded` on
  `getByRole('button', { name: 'Repository settings', exact: true })` at line
  238: the element resolved but stayed "not visible". The screenshot shows the
  phone layout with the tools popover closed.
- **Suite counts:** 9 passed, 2 skipped, 1 failed.
- **Reruns:** the narrow case alone passed three times (8.2 s, 8.4 s,
  8.3 s), the desktop and narrow pair passed three times, and the following full
  `mise run test:agent:browser:isolated --agent-platforms codex,opencode,cursor,grok`
  passed it (21 passed, 12 skipped, 1 failed: the doc 02 move case).
- **Evidence:** the failure's trace was overwritten by the passing reruns; only
  the log at `/tmp/ork-d4538-shell-run.log` on the observing host remained.
- **Hypothesis:** `MobileAppShellLayout` closes the tools popover on every
  selected project or environment change. The spec picks the fixture project
  from the drawer and opens the tools at once, so a selection change that
  lands after the click (for example the project's Home environment being
  selected) closes the popover again. The run also carried the `AppShell`
  change that keeps content mounted across the mobile breakpoint, but this case
  loads at 390 px and never crosses it. Not confirmed.

## Messaging review revalidation (2026-10-15)

Reproduced the same hidden "Repository settings" button while validating the
mail fixes on branch `agent-mail-coordination-f5d292441f98-r1`:

- `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  on profile `qa-browser-48efe423-6ef`: 22 passed, 14 skipped, 1 failed. The
  changed mail flow (inactive recipient, reload and one-message release without
  changing inherited Off) passed. Failure log:
  `/tmp/orkestrator-test-run.a97rK1/isolated-browser.log.gz`.
- Reran the entire owning file separately with
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-mail-review-1015 mise run test:logged -- --name browser-gateway-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`:
  10 passed, 5 skipped, 1 failed at the same click. Failure log:
  `/tmp/orkestrator-test-run.D8U732/browser-gateway-rerun.log.gz`.
- Both runs used fixture profiles with no agent credentials and Codex enabled.
  Screenshots and traces are under
  `output/agent-testing/<profile>/browser/artifacts/` on the observing host.

The isolated owning-file failure means this recurrence is still reproducible;
this validation does not establish a new flaky classification or resolve the
existing hypothesis. The mail changes do not alter the tools popover or project
selection. No assertions were skipped or weakened.

## PR base review revalidation (2026-10-15)

Reproduced the same hidden "Repository settings" button at line 238 while
validating branch `pr-target-branch-277220bf3f57-r1`:

- `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  on profile `qa-browser-9b299d21-51a`: 22 passed, 14 skipped, 1 failed
  (330.9 s including startup and cleanup). Evidence:
  `/tmp/orkestrator-test-run.yH0RwJ/isolated-browser.log.gz` and
  `output/agent-testing/qa-browser-9b299d21-51a/browser/`.
- The entire owning file on a fresh, credential-free Codex fixture profile:
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pr-base-277220bf mise run test:logged -- --name gateway-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`
  reproduced the same 15000 ms timeout: 10 passed, 5 skipped, 1 failed
  (90.7 s). Evidence: `/tmp/orkestrator-test-run.m5RjIB/gateway-rerun.log.gz`
  and `output/agent-testing/qa-pr-base-277220bf/browser/`.

This recurrence fails in isolation too. The PR-base change does not modify the
tools popover or project selection; the existing issue remains open. No
assertions were skipped or weakened. Both disposable profiles were stopped and
reset after validation.

## Terminal transport recovery revalidation (2026-10-15)

The same hidden "Repository settings" button recurred while validating terminal
transport recovery on branch `terminal-input-issue-ccc06ff4761a-r1`:

- `mise run test:logged -- --name browser-recovery -- mise run test:agent:browser:isolated`
  on fixture profile `qa-browser-3a4ddc8d-34b`: 24 passed, 14 skipped, 1 failed
  at the existing narrow host-picker click. Both new terminal-only SSE and
  WebSocket recovery cases passed, including automatic shell replacement,
  inactive-environment output and reload. Failure log:
  `/tmp/orkestrator-test-run.I32g1i/browser-recovery.log.gz`.
- The terminal owning file separately passed all three cases on credential-free
  fixture profile `qa-terminal-review-1015` using
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-terminal-review-1015 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-terminal-review-1015-terminal-final mise run test:logged -- --name terminal-browser-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/terminal-input-resume.spec.ts --workers=1`.

- The full unchanged browser-gateway owning file passed alone: 11 passed,
  5 opt-in skips, including the narrow host-picker case, using
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-terminal-review-1015 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-terminal-review-1015-gateway mise run test:logged -- --name browser-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
  Sanitized browser evidence is under
  `output/agent-testing/qa-terminal-review-1015-gateway/browser/`.

The terminal changes do not modify project selection or the tools popover.
No existing assertions were skipped or weakened.

## Coordinator launch-defaults review validation — 2026-10-16

On `0d254a3a`, the complete owning-file rerun reproduced the same narrow
host-picker timeout at line 238:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-launch-defaults-history-rerun mise run test:logged -- --name browser-gateway-isolated-rerun -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts
```

Result: 10 passed, 5 skipped, 1 failed; 157.4 seconds, one Playwright worker.
Evidence: `/tmp/orkestrator-test-run.v5zz3s/browser-gateway-isolated-rerun.log.gz`
and `output/agent-testing/qa-launch-defaults-history-rerun/browser/`.
The profile used `dev:test --fixture --no-agent-credentials --agent-platforms codex`.

The preceding full isolated browser suite used
`mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
on profile `qa-browser-96d6e8a6-ca0`: 24 passed, 14 skipped, 1 failed,
506.9 seconds including startup and cleanup. Its narrow host-picker case passed;
the failure instead occurred in `real browser gateway exercises an authoritative
local environment` at line 581: the terminal snapshot already held
`background-done`, but the immediate history-page read did not contain it.
Evidence: `/tmp/orkestrator-test-run.cjrgnN/isolated-browser.log.gz` and
`output/agent-testing/qa-browser-96d6e8a6-ca0/browser/`.

That terminal scenario passed separately (one test, exit 0, 8.9 seconds):

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-launch-defaults-history-rerun mise run test:logged -- --name terminal-history-rerun -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts --grep 'real browser gateway exercises an authoritative local environment'
```

It also passed in the complete owning-file rerun above, whose only failure
was the known host-picker case. This does not establish a new file-wide passing
rerun for classifying the terminal-history observation as a separate flake.
The snapshot and history read may observe different persistence progress; the
cause remains unconfirmed. No terminal, picker, assertion, deadline or skip was
changed. Both profiles were stopped and reset after validation.

## Unread-toast main merge validation — 2026-10-16

- `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated` on credential-free Codex profile `qa-browser-910af09e-8ee` reported 25 passed, 14 opt-in skips and one failure (536.5 s including lifecycle). The narrow host picker reached the socket dialog but `Select file` stayed disabled after entering the socket path (line 302, five-second visibility/enablement wait). Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.0YUiYo/merge-agent-browser.log.gz` and `output/agent-testing/qa-browser-910af09e-8ee/browser/`.
- The full unchanged owning file on fresh credential-free Codex fixture profile `qa-unread-merge-owner` used `ORKESTRATOR_AGENT_TEST_PROFILE=qa-unread-merge-owner ORKESTRATOR_AGENT_TEST_RUN_ID=qa-unread-merge-owner mise run test:logged -- --name merge-gateway-browser-owner -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts`. It reported 10 passed, five opt-in skips and one failure (110.1 s). The same narrow case failed earlier, with `Repository settings` hidden after `Open tools` (line 238, 15-second timeout). Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.PU8KT2/merge-gateway-browser-owner.log.gz` and `output/agent-testing/qa-unread-merge-owner/browser/`.
- The changed project-home unread/background path passed in both runs. These results do not establish a new flake or resolve the existing picker issue; neither test nor picker code was changed in this merge. Both profiles were stopped and reset after validation.

## Container platform qualification — 2026-10-17

On `main` at `31d0fb06`, on branch `todo-container-live-qualification-8efe5278910a-r1`,
the full isolated browser suite hit the same hidden "Repository settings"
button at line 238:
`mise run test:logged -- --name cq8efe-browser-isolated -- mise run test:agent:browser:isolated`
on profile `qa-browser-d9e826bd-9ed` reported 25 passed, 15 skipped and 1
failed (421.7 s). The host was under heavy load (load average about 20 on 18
cores). The desktop and narrow host-picker pair then passed alone on profile
`cq8efe-docker`:
`ORKESTRATOR_AGENT_TEST_PROFILE=cq8efe-docker bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --grep "host picker" --workers=1`
(2 passed, 17.9 s). The branch changes `paneLayoutStore.reset` only; it does
not touch the tools popover or project selection. No assertion was changed.

## Environment cleanup qualification — 2026-10-17

- `mise run test:agent:browser:isolated` on credential-free Codex profile `qa-browser-8311cc1a-7e5` (`main` `31d0fb06` plus the environment cleanup branch) reported 25 passed, 15 opt-in skips and one failure: this narrow case, `Repository settings` hidden after `Open tools` (line 238, 15-second timeout). Evidence: `output/agent-testing/qa-browser-8311cc1a-7e5/browser/`.
- Run alone three times on fresh profile `qa-envclean-05b87b2c`: failed once, then passed twice (9.3 s, 9.8 s). That is the first reproduction in a single-test run, so the race does not need suite load. The branch changes neither the picker, the mobile shell nor this test. The profile was stopped and reset.

## Multi Review qualification — 2026-10-17

- `mise run test:agent:browser:isolated` on `31d0fb06` (credential-free Codex profile `qa-browser-bca24bc9-5a5`, macOS arm64, about ten other live test environments on the host) reported 25 passed, 18 opt-in skips and one failure (6.8 min). The narrow case timed out with `Repository settings` resolved but "not stable" then "not visible" after `Open tools` (line 238, 15-second timeout).
- On a fresh credential-free fixture profile (`dev:test --profile mrqhp-a5927117 --fixture --no-agent-credentials --agent-platforms codex`), `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --grep "host picker creates" --repeat-each=2` passed all four runs (desktop and narrow twice, 36.7 s). The profile was stopped and reset afterwards.
- Nothing about the picker, the assertion or its deadlines was changed.

## Multi Review recovery follow-up — 2026-10-17

On `4443c027` plus the provider recovery fixes, the isolated browser run with
`ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1` reproduced the existing narrow
picker failure: `Repository settings` became hidden after `Open tools`
(line 238, 15-second click timeout). The fixture profile was
`qa-browser-67110e54-b3a`, one Playwright worker on a loaded macOS arm64 host.
Result: 25 passed, 18 opt-in skips, one failure, exit 1, 489.7 seconds.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9PgCqj/isolated-live-opt-in.log.gz`.
All four live Multi Review cases remained skipped despite the inherited opt-in.
The isolated runner stopped and reset its profile automatically.

The full unchanged owning file was then run on a fresh credential-free Codex
fixture profile:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-review-gateway-owner mise run test:logged -- --name gateway-owner -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts
```

It reproduced the same narrow picker timeout: 10 passed, five opt-in skips,
one failed, 140.1 seconds, exit 1. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.erLCbH/gateway-owner.log.gz`
and `output/agent-testing/qa-review-gateway-owner/browser/`. This does not
establish a new passing owning-file rerun or resolve the existing issue.
The picker, its assertions and deadlines were unchanged. The owning-file
profile was stopped and reset.

## Retired-dispatch recovery validation — 2026-10-17

The isolated credential-free Codex browser run on `8a2f9444` plus the retired-dispatch fixes reproduced the hidden `Repository settings` button at line 238 on profile `qa-browser-456a08a1-2d6`: 26 passed, 25 opt-in skips, two failed (the other failure is case 0380), 592.1 seconds including startup and cleanup. Command: `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated --no-agent-credentials`. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.SZD34s/isolated-browser.log.gz`.

The unchanged full owning file passed on fresh credential-free Codex fixture profile `qa-retired-owner-b37f`: `ORKESTRATOR_AGENT_TEST_PROFILE=qa-retired-owner-b37f ORKESTRATOR_AGENT_TEST_RUN_ID=retired-gateway-owner mise run test:logged -- --name gateway-owner -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts` (13 passed, six opt-in skips, 145.4 seconds including CLI build). Evidence: `output/agent-testing/retired-gateway-owner/browser/`. Both profiles were stopped and reset. No picker implementation, assertion, timeout or skip changed.

## Clean-review PR status follow-up — 2026-10-17

On branch `verify-fix-pr-b8cf5787ccea-r1`, the clean-review status and notice
regressions passed, including the desktop/mobile Multi Review browser suite.
The complete credential-free isolated browser run reproduced this existing
narrow host-picker timeout at line 238: `Repository settings` became hidden
after `Open tools`. Result: 27 passed, 25 opt-in skips, one failed (418.3 s).
Profile: `qa-browser-f323498a-c68`. Failure log:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Bd8mJf/isolated-browser.log.gz`.

The unchanged owning file was rerun on a fresh credential-free Codex fixture:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-clean-review-owner-b8cf mise run test:logged -- --name browser-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1
```

It reproduced the same timeout: 12 passed, six opt-in skips, one failed
(109.3 s). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BHn8NP/browser-gateway-owner.log.gz`
and `output/agent-testing/qa-clean-review-owner-b8cf/browser/`.
This recurrence fails in isolation too; it does not establish a passing
owning-file rerun or resolve issue 0224. The picker, its assertions and
deadlines were unchanged. Both disposable profiles were stopped and reset.

## Pending Resolve review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name resolve-isolated-browser -- mise run test:agent:browser:isolated` on credential-free Codex fixture profile `qa-browser-17a015ee-6d4`, one Playwright worker alongside repository/component-browser validation.
- **Failure:** The narrow host-picker case timed out after 15000 ms waiting to click the hidden `Repository settings` button at line 238.
- **Suite counts:** 27 passed, 25 skipped and one failed across 53 cases (549.7 seconds including startup and cleanup).
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-resolve-review-9f1a4 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-resolve-review-9f1a4-gateway mise run test:logged -- --name resolve-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed the unchanged file: 13 passed, six skipped, exit 0 in 135.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FifXht/resolve-isolated-browser.log.gz`; sanitized browser results under `output/agent-testing/qa-browser-17a015ee-6d4/browser/` and `output/agent-testing/qa-resolve-review-9f1a4-gateway/browser/`.
- **Assessment:** Matches the existing intermittent tools-popover symptom. The Pending Resolve change does not alter project selection or popover dismissal. Both profiles were stopped and reset; no timeout, assertion or skip changed.

## Device-login review validation (2026-10-17)

`mise run test:logged -- --name login-isolated-browser -- mise run test:agent:browser:isolated`
reproduced the same hidden Repository settings button at line 238 after
Open tools (15-second click timeout). The run finished with 27 passed,
25 skipped and one failed in 8.7 minutes. Account switching and signed-out
Codex recovery through inactive environments and reload passed. The
credential-free profile `qa-browser-bdfd649e-0a6` was stopped and reset by the
runner. No assertion, timeout or skip was changed; this run does not establish
an additional flaky classification or resolve the existing issue.

Evidence: `orkestrator-test-run.SROwT8/login-isolated-browser.log.gz` in the
host temporary directory and
`output/agent-testing/qa-browser-bdfd649e-0a6/browser/`.

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
(profile `qa-browser-41627cc5-72a`, one worker) reported 26 passed, 25 skipped
and three failed in 649.4 s logged. The narrow host picker again timed out
clicking `Repository settings` after 15000 ms. The other failures were local
move cleanup at the 120-second test deadline and the 390px host-maintenance
fixture's project-drawer click. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YMsYVb/isolated-browser.log.gz`.

The unchanged owning file on fresh profile `preview-path-layout-recheck`:
`ORKESTRATOR_AGENT_TEST_PROFILE=preview-path-layout-recheck ORKESTRATOR_AGENT_TEST_RUN_ID=preview-path-layout-recheck mise run test:logged -- --name gateway-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`
reported 13 passed, six skipped and one failed in 144.7 s. Only the same narrow
host-picker click failed; both other cases passed. This owning-file result
does not establish new flaky classifications. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ULvAuU/gateway-rerun.log.gz`.
Both disposable profiles were stopped and reset. No assertion or timeout changed.

## Landing-page main merge observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-real-stack -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-e5113038-5d8`, one Playwright worker. The narrow host-picker case found a disabled selector at its five-second deadline. The overall runner reached its 900-second test deadline while later attachment cases were running, then stopped and reset the profile.
- **Owning-file rerun:** on a fresh `dev:test --profile merge-15f6cd-gateway --fixture --no-agent-credentials --agent-platforms codex` profile, `ORKESTRATOR_AGENT_TEST_PROFILE=merge-15f6cd-gateway ORKESTRATOR_AGENT_TEST_RUN_ID=merge-15f6cd-gateway-rerun mise run test:logged -- --name merge-15f6cd-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 13 passed, 6 skipped and 1 failed in 177.6 seconds.
- **Rerun failure:** the same narrow case could not click `Repository settings` after `Open tools`: the button was unstable, then hidden, until the 15000 ms deadline (`browser-gateway.spec.ts:238`).
- **Evidence:** `orkestrator-test-run.ZDtnJp/merge-real-stack.log.gz` and `orkestrator-test-run.ru93zY/merge-15f6cd-gateway-owner.log.gz` below the host temporary directory; Playwright evidence under `output/agent-testing/merge-15f6cd-gateway-rerun/browser/`.
- **Disposition:** reproduced in the owning file, so this observation does not independently establish a flake. The narrow tools-popover path remains an unresolved validation limitation. No gateway source, assertion, timeout or skip changed. Both disposable profiles were stopped and reset.


## Inactive MCP qualification main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-be78767f-df2`, one Playwright worker alongside the full non-iOS suite.
- **Failure:** the narrow host-picker case could not click `Repository settings` after `Open tools`; the button became unstable, then hidden, until the 15000 ms deadline at `browser-gateway.spec.ts:238`.
- **Owning-file rerun:** fresh `dev:test --profile merge-mcp-gateway-1018 --fixture --no-agent-credentials --agent-platforms codex`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-mcp-gateway-1018 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-mcp-gateway-1018-rerun mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reproduced the same failure (13 passed, six skipped, one failed; exit 1 in 124.6 seconds).
- **Full browser result:** 28 passed, 32 opt-in skips and one failed, exit 1 in 401.0 seconds including startup and cleanup. The runner stopped and reset `qa-browser-be78767f-df2`.
- **Evidence:** `orkestrator-test-run.9diLAg/merge-agent-browser.log.gz` and `orkestrator-test-run.zvqJO1/merge-gateway-owner.log.gz` below the host temporary directory; browser artifacts under `output/agent-testing/qa-browser-be78767f-df2/browser/` and `output/agent-testing/merge-mcp-gateway-1018-rerun/browser/`.
- **Disposition:** this occurrence fails in isolation too and does not establish a new flake classification or resolve issue 0224. No picker implementation, assertion, timeout or skip changed. The owning-file profile was stopped and reset.

## Transcript-paging main merge — 2026-10-18

`mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated` reproduced the disabled SSH socket selection at `browser-gateway.spec.ts:302` in the narrow case (5000 ms). The one-worker credential-free Codex suite ran alongside component tests, the non-iOS aggregate and other worktrees. It later reached its test deadline before completing (933.4 s including startup/cleanup); the other reported failures are recorded in 0484.

The complete unchanged owning file passed against fresh credential-free profile `merge-paging-gateway-owner-1018`: `ORKESTRATOR_AGENT_TEST_PROFILE=merge-paging-gateway-owner-1018 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-paging-gateway-owner-1018 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` (14 passed, six skipped; exit 0 in 199.5 s logged). Both profiles were stopped and reset. Evidence: `orkestrator-test-run.h4wMTk/merge-agent-browser.log.gz` below the host temporary directory; Playwright statistics under `output/agent-testing/merge-paging-gateway-owner-1018/browser/results.json`. No implementation, assertion, timeout or skip changed.

## CLI matrices second main merge observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-isolated-browser -- mise run test:agent:browser:isolated`, credential-free profile `qa-browser-57ff09b9-afe`, one worker.
- **Failure:** narrow `Repository settings` click timed out after 15000 ms at `browser-gateway.spec.ts:238`: the target was unstable, intercepted, then hidden. The full 61-case browser run reported 27 passed, 32 skipped and two failed (900.4 seconds logged); the other failure was the persisted diff-baseline header assertion.
- **Owning-file rerun:** fresh credential-free profile `qa-browser-925150d4-008`, through the existing `runIsolatedBrowser` helper with a temporary ignored config importing the normal browser config and restricting `testMatch` to `browser-gateway.spec.ts`. Command: `mise run test:logged -- --name merge2-gateway-owner -- bun -e 'import { runIsolatedBrowser } from "./apps/desktop/scripts/dev/isolated-browser.ts"; process.exitCode = await runIsolatedBrowser({ suite: { label: "gateway owner", config: "output/agent-testing/merge2-gateway-owner.config.ts" } });'`.
- **Result:** the narrow picker case passed unchanged, but the whole owner reported 13 passed, five skipped and two failed (407.2 seconds logged): signed-out Codex lacked the `Sign in to Codex` button at 60000 ms, and the persisted diff-baseline `vs <tip>` header was absent at 5000 ms. Those remain validation limitations, not newly confirmed flakes.
- **Evidence:** `orkestrator-test-run.eQ9vnb/merge2-isolated-browser.log.gz` and `orkestrator-test-run.iQOZTp/merge2-gateway-owner.log.gz` below the host temporary directory; artifacts under `output/agent-testing/<profile>/browser/` for the two profiles named above.
- **Cleanup:** both profiles were stopped and reset by their owning runners; no live launcher or retained profile state. No implementation, assertion, timeout or skip changed.

## Electron preview second main merge — 2026-10-18

`mise run test:logged -- --name merge2-isolated-browser -- mise run test:agent:browser:isolated` used credential-free profile `qa-browser-42db909f-bde`, one worker. It reported 28 passed, 33 opt-in skips and one failed (exit 1, 484.6 seconds including setup and cleanup). The narrow picker again could not click `Repository settings` after `Open tools`: the button was unstable, then hidden, until the 15000 ms deadline at `browser-gateway.spec.ts:238`. Evidence: `orkestrator-test-run.DoYcml/merge2-isolated-browser.log.gz` below the host temporary directory. The supervisor stopped and reset the profile. The owner was not rerun for this occurrence, so this does not independently establish a new flake classification. No picker implementation, assertion, timeout or skip changed.

The component/public-site browser task passed separately (`merge2-browser`, exit 0, 135.0 seconds), as did credential-free CLI scenarios (`merge2-cli-scenarios`, exit 0, 23.6 seconds). Credentialed provider and separate Electron, Docker and iOS scenario suites were omitted; the incoming product changes were covered by the ordinary full suite, component browser and isolated browser flows.


## Upgrade-channel second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-isolated-browser -- mise run test:agent:browser:isolated`, credential-free Codex profile `qa-browser-75aa6285-358`, one worker. Result: 28 passed, 35 skipped and one failed (exit 1, 430.1 seconds including lifecycle). The narrow host-picker case timed out clicking `Repository settings` at line 238 after 15000 ms; the target became unstable and then hidden.
- **Owning-file rerun:** fresh credential-free profile `qa-merge2-gateway-129e`, started with `mise run dev:test --profile qa-merge2-gateway-129e --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=qa-merge2-gateway-129e ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-gateway-owner ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge2-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1` reported 13 passed, six skipped and one failed (exit 1, 228.0 seconds).
- **Owner result:** the narrow host-picker case passed unchanged. The persisted diff-baseline case at line 2091 instead failed its five-second `vs <tip>` title visibility assertion at line 2182. This is the existing observation tracked by 0494; it is not a new confirmed flaky classification because the owning file did not pass as a whole.
- **Evidence:** `orkestrator-test-run.IadNvo/merge2-isolated-browser.log.gz` and `orkestrator-test-run.HrHKpb/merge2-gateway-owner.log.gz` under the host temporary directory; browser traces under `output/agent-testing/qa-browser-75aa6285-358/browser/` and `output/agent-testing/merge2-gateway-owner/browser/`.
- **Cleanup and disposition:** the one-shot supervisor stopped/reset its profile. The owning-file profile was stopped and reset with `dev:stop` and `dev:reset`, both exit 0; its foreground launcher then exited 143 as requested. Gateway validation remains non-green. No implementation, assertion, deadline or skip changed.

## Keep-open picker main merge — 2026-10-19

- **Original command:** `mise run test:logged -- --name merge-agent-browser-installed -- mise run test:agent:browser:isolated`, credential-free Codex profile `qa-browser-21ee1ef6-070`, one worker, alongside the non-iOS aggregate and component/Electron checks. Result: 28 passed, 35 skipped and one failed (exit 1, 440.4 seconds including startup and cleanup). The narrow host-picker case timed out clicking the hidden `Repository settings` button at line 238 after 15000 ms.
- **Owning-file rerun:** fresh credential-free profile `qa-merge-picker-owner`, started with `mise run dev:test --profile qa-merge-picker-owner --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=qa-merge-picker-owner ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-owner-20261019 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1` reported 12 passed, six skipped and two failed (exit 1, 228.1 seconds).
- **Owner result:** the narrow picker repeated the same hidden-button failure. Separately, `project Home retains background work and unread attention beneath the board` reached the 120000 ms test deadline waiting for the fixture project button at line 424, before its background-work assertions. That Home case passed in the full isolated run; this owner failure is an unresolved observation and does not establish a new flake classification.
- **Evidence:** `orkestrator-test-run.YIyNdG/merge-agent-browser-installed.log.gz` and `orkestrator-test-run.VCmB1X/merge-gateway-owner.log.gz` below the host temporary directory; browser results/traces under `output/agent-testing/qa-browser-21ee1ef6-070/browser/` and `output/agent-testing/merge-gateway-owner-20261019/browser/`.
- **Cleanup and disposition:** both profiles were stopped and reset; explicit owner `dev:stop` and `dev:reset` exited 0. Gateway validation remains non-green. No implementation, assertion, timeout or skip changed. The full repository suite passed separately (`merge-tests-installed`, 266.7 seconds), as did builds, typechecking, component/public-site browser checks and credential-free CLI scenarios.

## Queued-steer main merge validation — 2026-10-19

The recurrence, owning-file results and remaining limitations are recorded in
[0501](../aggregate-validation-runs/0501-queued-steer-main-merge-validation.md). No owning implementation,
assertion, timeout or skip was changed for validation.

## File/LOC change-tracking validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name change-tracking-browser -- mise run test:agent:browser:isolated` on branch `implement-file-change-f3950a40ac3a-r1` (uncommitted change-tracking implementation on `97af3d45`), macOS arm64.
- **Failure:** "Repository settings" stayed hidden after "Open tools" at the narrow width (`locator.click` timeout, 15 s). The suite reported 27 passed, 37 skipped and 2 failed; the other failure was a real diff-tab title regression in this branch, since fixed.
- **Owning-test reruns:** against a disposable local profile with `--grep "persisted diff baselines|host picker creates"`, the narrow case failed once more in a first rerun, then failed 1 of 2 under `--repeat-each=2` (5 passed, 1 failed overall); the desktop case passed every time. Profiles were stopped and reset.
- **Trace analysis (ct-qa-56068):** the project click at 1466 ms issued `ensure_project_home_environment` (1601 ms); "Open tools" was clicked at 1625 ms and the "Repository settings" click began at 1664 ms but waited on the popover's 150 ms open transition ("element is not stable"). The home environment was selected at about 1789 ms (its `list_prompt_queues`/`get_pane_layout` reads), and `MobileAppShellLayout` closes the tools popover on any selection change, so the button became hidden before the click landed. The branch's first change-tracking request (`changes_get_view`) came at 1813 ms, after the selection, so it did not cause the close. This supports the late-selection hypothesis: the spec opens tools before the project's home environment selection settles.
- **Side fix:** `changes_get_view` no longer runs a full diff-stats reconcile when the environment is already tracked; a reconcile reloads every environment and was queued once per projection reader. The narrow case still failed 1 of 6 afterwards, consistent with the race above.
- **Rates on this branch:** the narrow case failed 4 of 15 runs overall; with the branch's action-bar change temporarily reverted it passed 4 of 4. That is too small a sample to separate the two; the trace above is the stronger evidence.
- **Evidence:** `orkestrator-test-run.yJXAyR` below the host temporary directory; browser artifacts under `output/agent-testing/ct-qa-45617/` and `output/agent-testing/ct-qa-57405/`.

## Git-fixture main merge validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:agent:browser:isolated`, credential-free Codex profile `qa-browser-320b81f4-807`, one worker, alongside the non-iOS aggregate and Electron/Docker checks.
- **Full result:** 27 passed, 38 opt-in skips, two failed; exit 1 in 539.1 seconds including lifecycle. The narrow picker reached the five-second deadline with `Select file` disabled in the SSH socket dialog (line 303). Separately, signed-out Codex recovery could not find `Sign in to Codex` within 60 seconds (line 881).
- **Owning-file rerun:** `mise run test:logged -- --name merge-gateway-owner -- bun -e 'import { runIsolatedBrowser } from "./apps/desktop/scripts/dev/isolated-browser.ts"; process.exitCode = await runIsolatedBrowser({ suite: { label: "gateway owner", config: "output/agent-testing/merge-gateway-owner.config.ts" } });'`. The ignored temporary config imported the normal browser config and restricted `testMatch` to `browser-gateway.spec.ts`; fresh credential-free Codex profile `qa-browser-8a68726c-057`, one worker.
- **Owner result:** 14 passed, seven skipped, one failed; exit 1 in 168.0 seconds. The narrow picker reproduced the hidden `Repository settings` button after `Open tools` (line 239, 15-second timeout). The signed-out Codex recovery case passed unchanged, but the whole owning file did not, so this observation does not independently classify a new flake.
- **Evidence:** `orkestrator-test-run.Ow1M3o/merge-browser.log.gz` and `orkestrator-test-run.MWfKgp/merge-gateway-owner.log.gz` below the host temporary directory; browser artifacts under `output/agent-testing/<profile>/browser/` for the two profiles above.
- **Disposition:** existing narrow-picker limitation remains unresolved. Both supervisors stopped and reset their profiles. No source, assertion, deadline or skip changed.


## Idle-observation review validation (2026-10-21)

The narrow host-picker timeout recurred while validating the idle-observation
assertions and isolated-runner opt-in default:

- `ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  on credential-free Codex fixture `qa-browser-b58be031-38c`: 28 passed,
  44 skipped, one failed (402.7 s including startup/cleanup). The failure was
  the same 15 s click on hidden `Repository settings` at
  `browser-gateway.spec.ts:239`, after `Open tools`. All six idle-observation
  live cases stayed skipped despite the inherited opt-in. Evidence:
  `orkestrator-test-run.ObH8th/isolated-browser.log.gz` in the host temporary
  directory and `output/agent-testing/qa-browser-b58be031-38c/browser/`.
- The complete unchanged owning file was rerun with one worker in a fresh
  credential-free Codex fixture, `qa-browser-50d29a4f-6e8`, using
  `runIsolatedBrowser` with a temporary config selecting only
  `browser-gateway.spec.ts` (`mise run test:logged -- --name gateway-owner -- bun output/idle-review/gateway-run.ts`).
  It reproduced the same narrow click failure: 14 passed, seven skipped, one
  failed (144.8 s). Evidence: `orkestrator-test-run.BevcYq/gateway-owner.log.gz`
  in the host temporary directory and
  `output/agent-testing/qa-browser-50d29a4f-6e8/browser/`.

The owning-file failure leaves this recurrence reproducible in isolation; this
run does not establish a new flaky classification. The existing late-selection
hypothesis remains unconfirmed by this run. No assertions were skipped or
weakened. Both profiles were stopped/reset, and the temporary runner/config
files were removed.

## Command-node review validation recurrence — 2026-10-21

- `mise run test:logged -- --name review-real-browser-confirm -- mise run test:agent:browser:isolated` reported 28 passed, 39 skipped and one failed (649.2 seconds including lifecycle). The narrow host picker reproduced the hidden `Repository settings` button after `Open tools` at line 239, with a 15-second click timeout.
- A fresh credential-free Codex profile ran the entire owning file using `mise run test:logged -- --name review-real-browser-owner -- bun --eval 'import { runIsolatedBrowser } from "./apps/desktop/scripts/dev/isolated-browser.ts"; process.exitCode = await runIsolatedBrowser({ suite: { label: "gateway owning file", config: "output/agent-testing/review-gateway-owner/playwright.config.ts" } });'`. The ignored temporary config imports the normal browser config and limits `testMatch` to `browser-gateway.spec.ts`.
- The owner reported 14 passed, eight skipped and the same narrow failure (149.1 seconds including lifecycle). This observation remains unresolved; it does not independently classify a new flake. All other gateway scenarios passed.
- Evidence: `orkestrator-test-run.q64d2n` and `orkestrator-test-run.y7CZNk` in the host temporary directory. Both disposable profiles were stopped and reset. No implementation, assertion, deadline or skip in the failing scenario changed.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-isolated-app -- mise run test:agent:browser:isolated` used credential-free Codex profile `qa-browser-2eb7fe48-caf`, one worker. It reported 28 passed, 42 skipped and one failed (exit 1, 410.0 s including lifecycle). The narrow host picker timed out after 15000 ms clicking the hidden `Repository settings` button at `browser-gateway.spec.ts:240`.
- The entire unchanged owning file passed in fresh credential-free profile `qa-browser-8c7c15c3-57d`: `mise run test:logged -- --name merge-gateway-owner -- bun output/agent-testing/merge-d6e6-gateway-owner/run.ts` (exit 0, 151.5 s including lifecycle; 15 passed, nine skipped, zero failed). The ignored wrapper uses the existing `runIsolatedBrowser` supervisor/cleanup flow with a temporary config importing the normal browser config and restricting `testMatch` to `browser-gateway.spec.ts`; one worker.
- Evidence: `orkestrator-test-run.0b3dXe/merge-isolated-app.log.gz` below the host temporary directory; JSON results and browser artifacts under `output/agent-testing/<profile>/browser/` for the two profiles above. Both profiles were stopped and reset.
- The known late-selection/tools-popover race remains a hypothesis for this occurrence. No source, assertion, timeout or skip changed.

## ScheduleWakeup main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` used fresh credential-free Codex profile `qa-browser-08ffc422-c99` and one worker. It reported 28 passed, 42 skipped and one failed (exit 1, 412.7 seconds including lifecycle). The narrow host picker again timed out after 15000 ms clicking the hidden `Repository settings` button at `browser-gateway.spec.ts:240`.
- The complete unchanged owning file repeated the same failure on fresh credential-free profile `qa-browser-24393cc3-2b0`: `mise run test:logged -- --name merge-gateway-owner -- bun output/agent-testing/merge-c5e1-gateway-owner/run.ts` (exit 1, 146.0 seconds including lifecycle; 14 passed, nine skipped, one failed). The ignored wrapper uses the repository's supervisor and `runIsolatedBrowser` cleanup flow, with a temporary config importing the normal browser config and restricting `testMatch` to the complete `browser-gateway.spec.ts`; one worker.
- This occurrence remains unresolved validation, not a newly confirmed flake. No implementation, assertion, deadline or skip was changed to address it.
- Evidence: `orkestrator-test-run.GnQFi3/merge-isolated-browser.log.gz` and `orkestrator-test-run.x01o2B/merge-gateway-owner.log.gz` below the host temporary directory, plus browser artifacts under `output/agent-testing/<profile>/browser/`. Both profiles were stopped and reset successfully.

## Remote workspace refreshed main merge — 2026-10-21

- **Snapshot:** main `f228a6aa9` merged into pre-merge HEAD `aade0bcd53dc983ef89e072ace5509effbfee957`; the full 87-path merge scope was inspected, including automatic merges and integration fixes.
- **Original command:** `mise run test:logged -- --name refresh-real-browser -- mise run test:agent:browser:isolated`, one worker in credential-free profile `qa-browser-bf0d9b8b-3ab`.
- **Result:** 27 passed, 42 skipped and two failed; exit 1 after 484.2 seconds. The narrow host-picker case again timed out clicking the hidden or unstable Repository settings button. The capped-file-tree case also missed its `build` folder after reload at the five-second visibility deadline (line 802). Its trace exceeded the sanitizer's 16 MiB file bound, adding an artifact-processing error.
- **Complete owning-file rerun:** `mise run test:logged -- --name refresh-gateway-owner -- bun output/agent-testing/merge-main-validation/gateway-owner.ts` used the repository's supervisor and `runIsolatedBrowser` with a temporary config importing the standard browser config and restricting `testMatch` to `browser-gateway.spec.ts`. Fresh profile `qa-browser-91ae64dd-779` reported 14 passed, nine skipped and the same narrow host-picker failure (145.2 seconds). The capped-file-tree case passed; the complete owner remains non-green, so this does not classify a new flake for that case. No assertion, timeout or skip changed.
- **Evidence:** `orkestrator-test-run.CZyF1o/refresh-real-browser.log.gz` and `orkestrator-test-run.X462KZ/refresh-gateway-owner.log.gz` below the host temporary directory. Both disposable profiles were stopped and reset; no live launcher remains.
- **Other validation:** formatting, lint, all typechecks, production desktop build, focused merge and ScheduleWakeup tests, documentation links, and the complete component/public browser task passed. The complete non-iOS suite finished in 517.8 seconds: all workspace packages and protocol regeneration passed; its only failures were the unchanged Claude fixture and Pi staging cases, both of whose complete owners passed separately (0513 and 0514). The aggregate's original nonzero exit remains recorded.
- **Scope limitation:** dedicated Electron, Docker lifecycle, iOS and billed-provider qualification were not selected because this merge changes none of their owning implementations; unavailable provider/Docker browser scenarios remain explicit skips.

## Sidebar collapse/layout review validation — 2026-10-22

The full isolated browser run on feature branch
`fix-environment-indentation-fc91d4557412-r1` reproduced the hidden
`Repository settings` control after opening tools at 390 × 844:

- `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  used profile `qa-browser-f042f724-984`: 27 passed, 42 opt-in skips, two
  failed (the other was the private-canvas case). The Expand-project locator
  failures reported by the review did not recur. Failure evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9o1S1h/isolated-browser.log.gz`.
- A fresh credential-free Codex fixture profile, `qa-sidebar-review-repro`,
  reproduced the same narrow failure with
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-sidebar-review-repro mise run test:logged -- --name browser-narrow-repro -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts --grep 'host picker.*narrow|private canvases'`:
  one failed, one passed in 32.8 seconds. The private-canvas case passed.
  Failure evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.OfyDfK/browser-narrow-repro.log.gz`.

No assertion, timeout, skip, or production tools-popover behavior was changed
for this recurrence. The isolated runner stopped and reset its profile; the
manual reproduction profile was also stopped and reset after owner validation.

## Machines settings review validation — 2026-10-22

- **Scope:** branch `machines-settings-13fae198a6c1-r1`; maintenance navigation,
  machine labels, discovery fallback and saved-connection controls. The failing
  host-path scenarios were unchanged.
- **Original command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`,
  one worker, credential-free Codex profile `qa-browser-a27914dd-603`.
  Result: 27 passed, 42 skipped, two failed (exit 1, 424.0 seconds including
  lifecycle). The narrow picker timed out after 15000 ms clicking hidden or
  unstable `Repository settings` at `browser-gateway.spec.ts:240`. Separately,
  `typed project paths detect a remote and preserve newer manual URL edits`
  could not find the Add project dialog's Git URL input after its 2300 ms wait.
- **Complete owning-file rerun:** `mise run test:logged -- --name gateway-recheck -- bun output/machines-validation/recheck.ts`
  used `runIsolatedBrowser` with the normal browser configuration restricted to
  the complete `browser-gateway.spec.ts`, one worker and fresh credential-free
  profile `qa-browser-97da0d2c-6a8`. Result: 14 passed, nine skipped, one failed
  (exit 1, 139.1 seconds). The narrow picker repeated its 15000 ms timeout;
  the typed-path case passed. Since the complete owner remains non-green,
  this does not establish a new flake classification for the typed-path case.
- **Evidence:** host temporary-directory logs
  `orkestrator-test-run.uYTFen/isolated-browser.log.gz` and
  `orkestrator-test-run.Z58n1W/gateway-recheck.log.gz`; results and traces under
  `output/agent-testing/<profile>/browser/` for the profiles above. Both profiles
  were stopped and reset, and the temporary runner/config were removed.
- **Relevant validation:** both 1280px and 390px maintenance cases passed in
  both runs, proving completion with Settings closed and recovery after reload.
  All 36 Machines component-browser cases, focused renderer/routing tests,
  recurring-work checks, formatting, lint, typechecks and the complete non-iOS
  suite passed. The Machines Unicode correction uses macOS line-end navigation
  before Backspace; its original mobile failures reproduced alone before that
  fix. No assertion, timeout or skip was loosened. Dedicated Electron, Docker
  lifecycle, iOS and billed-provider suites were omitted because their owning
  implementations did not change.

## Idle-observation refreshed main merge — 2026-10-22

The narrow picker repeated the hidden `Repository settings` click timeout at
`browser-gateway.spec.ts:240` (15000 ms) in both the full isolated browser run
and the complete unchanged gateway owner on a fresh credential-free local-only
profile. The full run reported 27 passed, 51 skipped and two failed; the owner
reported 13 passed, 10 skipped and this single failure (127.0 seconds). The
other full-run failure, local-environment `origin` visibility, passed in the
owner, but the owner remains non-green. Commands, evidence and cleanup are
recorded in [0515](../aggregate-validation-runs/0515-idle-observation-main-merge-validation.md), under
“Main refresh”. No implementation, assertion, deadline or skip changed; this
recurrence remains unresolved rather than a newly confirmed flake.

## Sidebar refreshed main merge — 2026-10-22

- Pre-merge HEAD: `b0f24b642`; final merged main: `7e051d955`. The two documentation conflicts retained both branches' evidence, and the auto-merged gateway test kept the sidebar helpers and the newer Docker credential/seed checks.
- The initial `c17f1c8d5` merge passed `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` (553.6 s).
- The refreshed result's `mise run test:logged -- --name latest-isolated-browser -- mise run test:agent:browser:isolated` used profile `qa-browser-c741106c-c2a`: 28 passed, 51 opt-in skips and this one failure (436.3 s). The existing `Repository settings` click at line 241 exceeded 15,000 ms because the button was hidden. Evidence: `orkestrator-test-run.PltXEf/latest-isolated-browser.log.gz` under the host temporary directory; browser artifacts under `output/agent-testing/qa-browser-c741106c-c2a/browser/`.
- A fresh credential-free local fixture, `qa-sidebar-main-owner`, reproduced the same failure in the complete unchanged owner: `ORKESTRATOR_AGENT_TEST_PROFILE=qa-sidebar-main-owner mise run test:logged -- --name latest-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 13 passed, 10 skipped, one failed (122.0 s). Evidence: `orkestrator-test-run.rOneqe/latest-gateway-owner.log.gz` under the host temporary directory. This remains an unresolved limitation, not a newly confirmed flake.
- The refreshed complete non-iOS suite passed (447.3 s), as did format, lint, all typechecks, production build, focused storage/coordinator owners and Docker fixture (70.7 s). The initial component-browser run had 399 passed, 81 skipped and two failures; both complete unchanged owners passed separately (0174 and 0517), and the public-site suite passed separately. Initial aggregate disk-report, Mermaid and submodule-recovery failures also passed their complete owners (0259, 0512 and 0248).
- All disposable profiles were stopped and reset. No implementation, assertion, timeout or skip was changed to address these validation recurrences. Dedicated native Electron and iOS suites were omitted because no owning implementation changed; billed-provider qualification remained opt-in.

## Machines settings refreshed main merge — 2026-10-22

- **Merge:** `origin/main` at `7e051d955` into `814afe472` on `machines-settings-13fae198a6c1-r1`. The pending merge was refreshed after two new main commits appeared; the original non-IOS and browser attempts were interrupted and are not final coverage.
- **Full browser command:** `mise run test:logged -- --name latest-browser -- mise run test:agent:browser:isolated`, one worker, fresh credential-free Codex profile `qa-browser-e19f73e8-d2d`. Result: 28 passed, 51 skipped, one failed; exit 1 in 426.2 s including lifecycle. The narrow picker repeated the 15000 ms hidden/unstable `Repository settings` click timeout at line 240.
- **Complete unchanged owner:** `mise run test:logged -- --name latest-gateway-owner-fixed -- bun output/merge-main-validation/gateway-owner.ts` used `runIsolatedBrowser`, the normal browser config restricted to the complete `browser-gateway.spec.ts`, and fresh credential-free profile `merge-main-gateway-13fae198`. Result: 14 passed, nine skipped, one failed; exit 1 in 159.1 s. The same narrow-picker timeout repeated. Both 1280px and 390px maintenance-rehydration cases passed in both runs; capped-file-tree and persisted-diff cases also passed.
- **Earlier partial browser observation:** the interrupted `merge-browser` run on `c17f1c8d5` (`qa-browser-7fef7575-0d6`) had missed the capped-tree `build` folder at line 776. The refreshed suite and owning-file runs passed that case, but the owner remains non-green, so this observation does not independently establish a new flaky classification.
- **Evidence:** host temporary-directory logs `orkestrator-test-run.8VFQmt/latest-browser.log.gz`, `orkestrator-test-run.s6XsZB/latest-gateway-owner-fixed.log.gz`, and the interrupted `orkestrator-test-run.gd1T9F/merge-browser.log.gz`. Sanitized results/traces remain under `output/agent-testing/<profile>/browser/` for the profiles above.
- **Other verification:** formatting, lint, all typechecks, `build:all`, documentation command contracts, 1348 local Markdown links and the recurring-work harness passed. The updated non-IOS aggregate passed workspace, root/support and protocol; its sole failure was the Claude EnterPlanMode fixture race (0385), whose unchanged complete owner passed. Earlier Pi, disk-report and long-transcript deadline recurrences passed their complete unchanged owners (0514, 0259, 0627).
- **Docker and cleanup:** the development image built successfully. The full Docker fixture suite on `merge-main-docker-latest-13fae198` passed 10 cases with two live-provider skips (74.9 s); stop/reset removed two exact-owner containers, four volumes, one network and disposable state. The earlier Docker profile was also stopped/reset. Every browser profile above was stopped/reset, and temporary rerun scripts/configs were removed. No launcher or disposable state was deliberately retained.
- **Scope limitation:** dedicated Electron, CLI scenario and iOS suites were omitted because their owning implementations did not change; billed-provider scenarios retained their explicit opt-ins. No implementation, assertion, timeout or skip was changed. The narrow-picker recurrence remains unresolved.

## Sidebar incorporation of Machines — 2026-10-22

- Merge: `90e3e5226` into the already-pushed sidebar merge `4902a9282`. Conflicts in the flake index and cases 0224, 0259 and 0385 retain both branches' evidence. The routing and gateway-test auto-merges retain the sidebar work and the Machines maintenance navigation.
- `mise run test:logged -- --name machines-merge-isolated -- mise run test:agent:browser:isolated` passed (470.5 s), including this narrow-picker case and both maintenance viewports. Its disposable profile was stopped/reset by the runner. The complete component/public browser task passed (229.7 s), as did the Electron suite (251.5 s), CLI scenarios (47.0 s), production build, focused Machines tests, formatting, lint and every typecheck. All 432 local Markdown link targets checked existed.
- `mise run test:logged -- --name machines-merge-suite -- mise run test` completed in 539.5 s. Workspace packages, bridges and protocol regeneration passed; only the documented Pi-vendoring and disk-report deadline recurrences failed in root/support. Both complete unchanged owners passed separately (8.1 s and 1.1 s); evidence and worker configuration are in 0514 and 0259. The original aggregate exit remains nonzero.
- Main was fetched again after validation and remained `90e3e5226`. No assertions, deadlines or skips changed. Docker lifecycle and iOS scenarios were omitted because this incremental merge changes neither owning implementation; Docker coverage on the preceding merge remains recorded above. Billed-provider scenarios retain their explicit opt-ins.

## Recurring-work qualification main merge — 2026-10-22

`mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` used fresh credential-free profile `qa-browser-1aad6041-c52` and one Playwright worker after merging main `3b469e885` into pre-merge HEAD `61866a15b208019ee787038202be0e3381a42343`. The narrow case repeated the hidden/unstable `Repository settings` click timeout (15000 ms, `browser-gateway.spec.ts:241`). The suite reported 28 passed, 51 skipped and one failed (433.1 s logged including lifecycle). Both maintenance viewports, persisted diff and design cases passed.

Evidence is `orkestrator-test-run.IcTGSf/merge-isolated-browser.log.gz` below the host temporary directory. The runner stopped/reset its profile and removed disposable state. The unchanged gateway owner was not rerun separately for this observation, so this records an unresolved recurrence, not a new confirmed flake. No implementation, assertion, timeout or skip changed.

## Inherited-settings validation — 2026-10-22

- **Full command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`, one worker, fresh credential-free Codex profile `qa-browser-eee2ec83-1a5`.
- **Result:** 26 passed, 51 skipped and three failed across 80 cases (428.0 seconds including lifecycle). The narrow picker repeated the 15000 ms hidden/unstable `Repository settings` click timeout at `browser-gateway.spec.ts:241`. Both terminal recovery rendering cases also failed; those were investigated separately.
- **Owner rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=inherited-settings-qa-20daf002 mise run test:logged -- --name gateway-terminal-owners -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts e2e/agent-testing/terminal-input-resume.spec.ts --workers=1` used a fresh credential-free local fixture. It reported 16 passed, 10 skipped and only this failure (155.8 seconds). Both terminal recovery cases and both maintenance viewports passed.
- **Evidence:** host temporary-directory logs `orkestrator-test-run.VhN1Q9/isolated-browser.log.gz` and `orkestrator-test-run.pQu4zt/gateway-terminal-owners.log.gz`; sanitized artifacts under `output/agent-testing/<profile>/browser/` for the named profiles.
- The same known failure persists in its unchanged owner, so this observation remains unresolved. No picker implementation, assertion, timeout or skip changed. The full-run profile was stopped and reset by its runner.

## Sidebar collision main merge — 2026-10-22

- **Merge parents:** feature `8106d7821` and main `7b1066bc1`.
- **Original command:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`; credential-free Codex fixture profile `qa-browser-a3624124-244`, one Playwright worker.
- **Failure:** the narrow host-picker case repeated the 15000 ms click timeout at `browser-gateway.spec.ts:241`; Repository settings became hidden after Open tools. The suite reported 28 passed, 51 opt-in skips and one failed in 6.8 minutes. The authoritative local-environment smoke case passed in this run.
- **Complete unchanged owner rerun:** on a fresh credential-free Codex fixture profile `merge-gateway-owner-281c943b`, `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-owner-281c943b ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-owner-281c943b mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 12 passed, 10 skipped and two failed (155.3 seconds logged). The same narrow click failed again; the local-environment smoke also could not find fixture project `origin` at line 521 (related case 0494).
- **Evidence:** host temporary directories `orkestrator-test-run.CT3LS7/merge-isolated-browser.log.gz` and `orkestrator-test-run.gtNahW/merge-gateway-owner.log.gz`; browser artifacts under `output/agent-testing/qa-browser-a3624124-244/browser/` and `output/agent-testing/merge-gateway-owner-281c943b/browser/`.
- **Assessment:** this recurrence remains unresolved and does not independently establish intermittence. No gateway implementation, assertion, timeout or skip changed. Both profiles were stopped and reset.

## Command-node main merge — 2026-10-22

- **Merge parents:** feature `2f6fdfe2875cb6bb62499db1167f81b69ba5842e` and main `58c5df9f9bf68402d3c851f894608688594f77d7`.
- **Original command:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`; credential-free Codex fixture profile `qa-browser-8dbc46b0-80e`, one Playwright worker.
- **Result:** 28 passed, 51 opt-in skips and one failed, exit 1 after 532.1 seconds including lifecycle. The narrow host picker again timed out after 15000 ms on the hidden/unstable Repository settings button at `browser-gateway.spec.ts:241`.
- **Complete unchanged owner rerun:** fresh credential-free Codex fixture `merge-gateway-owner-20daf002`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-owner-20daf002 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-owner-20daf002 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 13 passed, 10 skipped and the same single failure, exit 1 after 140.4 seconds. The authoritative local-environment smoke, both maintenance viewports and persisted-diff baseline cases passed.
- **Evidence:** `orkestrator-test-run.bjwqdi/merge-isolated-browser.log.gz` and `orkestrator-test-run.FYNbrS/merge-gateway-owner.log.gz` below the host temporary directory; sanitized artifacts under `output/agent-testing/qa-browser-8dbc46b0-80e/browser/` and `output/agent-testing/merge-gateway-owner-20daf002/browser/`.
- **Assessment:** the known failure persists in the unchanged owning file, so browser validation remains non-green; this observation does not establish intermittence. No implementation, assertion, timeout or skip changed. Both profiles were stopped and reset.


## Node event main merge — 2026-10-23

`mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`
ran 82 cases with one Playwright worker in profile `qa-browser-3e02ccfc-572`,
alongside repository, component-browser and Electron suites: 26 passed,
53 skipped, three failed (574.7 s including lifecycle). Failures were:

- `host picker creates and browses folders through the authenticated gateway above fullscreen settings (narrow)`:
  the Repository settings button became hidden and its click exceeded 15 s.
- `real browser gateway exercises an authoritative local environment`:
  the fixture project `origin` was not visible at the 30 s deadline.
- `capped file tree retains source files and shows incomplete folders after reload`:
  the `build` folder button was missing at five seconds.

Teardown also reported a trace exceeding the 16 MiB sanitization limit for
the capped-file-tree case. This is a separate artifact error, not a test pass.
The one-shot profile was stopped and reset.

A fresh credential-free Codex profile, `merge-gateway-0331564a`, then ran the
complete unchanged owner with one worker:

```sh
mise run dev:test --profile merge-gateway-0331564a --fixture --no-agent-credentials --agent-platforms codex
ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-0331564a ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-0331564a mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1
```

It reported 13 passed, ten skipped and only the same narrow settings click
failure (125.7 s). Fixture visibility and capped-file-tree cases passed, but
the complete owner remains non-green; no new flake classification is made.
The manual profile was stopped and reset with `dev:stop` and `dev:reset`.
Evidence: host temporary artifacts `orkestrator-test-run.QHhbhR/merge-isolated-browser.log.gz`
and `orkestrator-test-run.AMX0fi/merge-gateway-owner.log.gz`; rerun artifacts
under `output/agent-testing/merge-gateway-0331564a/browser/`. No implementation,
assertion, timeout or skip changed.


## Per-machine agent accounts main merge — 2026-10-24

- **Parents:** feature `9f67a5963` and main `5282e441a`.
- **Original command:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-8e82b8e7-4e8`, one Playwright worker alongside repository/component validation and other worktrees.
- **Full-suite result:** 28 passed, 53 opt-in skips and one failed (641.3 s logged including lifecycle). The runner stopped and reset its profile.
- **Failure:** the unchanged narrow host-picker case repeated the 15000 ms hidden/unstable Repository settings click timeout at `browser-gateway.spec.ts:241`.
- **Complete unchanged owner:** fresh credential-free Codex fixture `merge-gateway-cb5bcc4a`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-cb5bcc4a ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-cb5bcc4a mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 13 passed, ten skipped and only the same failure (218.8 s logged). Both maintenance viewports, account recovery, local-environment smoke and persisted-diff cases passed.
- **Evidence:** host temporary artifact `orkestrator-test-run.Xcu2PF/merge-gateway-owner.log.gz`; browser artifacts under `output/agent-testing/merge-gateway-cb5bcc4a/browser/`. The owner profile was stopped and reset with `dev:stop` and `dev:reset`.
- **Assessment:** this known failure persists in the complete unchanged owner; it remains unresolved. No gateway implementation, assertion, timeout or skip changed.

## Transcript scroll smoothness validation — 2026-10-24

- `mise run test:agent:browser:isolated` (profile `qa-browser-ca22b087-f8c`,
  removed afterwards): 28 passed, 53 skipped, 1 failed — this case, again a
  `locator.click` timeout (15000 ms) in the narrow fullscreen-settings host
  picker. Screenshot:
  `output/agent-testing/qa-browser-ca22b087-f8c/browser/artifacts/browser-gateway-host-path--e1bef-fullscreen-settings-narrow-/test-failed-1.png`.
- The change under validation does not touch settings, the gateway or the
  host picker (web transcript scrolling, tool groups, Markdown streaming,
  the Virtuoso patch). No assertion, timeout or skip changed.


## Runtime-state ownership main merge — 2026-10-24

The merge parents are feature `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and main `0014505caeed69395b3cc996dd541fcc6df12c23`. The renderer and both browser owning files match `origin/main`; no assertion, timeout or skip changed. `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` used credential-free Codex profile `qa-browser-a81b23d3-fdf`, one browser worker, alongside other validating worktrees. It reached its 900 s test deadline after starting case 56 of 83, with four recorded failures and no complete Playwright summary (923.2 s including lifecycle). Its runner stopped/reset the profile. Evidence: host temporary artifact `orkestrator-test-run.flXegA/merge-isolated-browser.log.gz`. This case could not find the drawer toggle within five seconds at `browser-gateway.spec.ts:224`. The complete unchanged gateway owner ran on credential-free Codex/Docker fixture `merge-runtime-docker-1024`: `ORKESTRATOR_AGENT_TEST_PROFILE=merge-runtime-docker-1024 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-runtime-docker-1024-gateway mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`. It reported 13 passed, ten opt-in skips and one failed (316.6 s logged). The narrow host-picker case passed; the narrow maintenance case still failed while opening Updates. Evidence: `orkestrator-test-run.75cYgS/merge-gateway-owner.log.gz` under the host temporary directory and `output/agent-testing/merge-runtime-docker-1024-gateway/browser/`. The complete owner remains non-green, so this observation does not independently establish a new flake classification.
