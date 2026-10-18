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


## Landing-page main merge observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-real-stack -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-e5113038-5d8`, one Playwright worker. The narrow host-picker case found a disabled selector at its five-second deadline. The overall runner reached its 900-second test deadline while later attachment cases were running, then stopped and reset the profile.
- **Owning-file rerun:** on a fresh `dev:test --profile merge-15f6cd-gateway --fixture --no-agent-credentials --agent-platforms codex` profile, `ORKESTRATOR_AGENT_TEST_PROFILE=merge-15f6cd-gateway ORKESTRATOR_AGENT_TEST_RUN_ID=merge-15f6cd-gateway-rerun mise run test:logged -- --name merge-15f6cd-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` reported 13 passed, 6 skipped and 1 failed in 177.6 seconds.
- **Rerun failure:** the same narrow case could not click `Repository settings` after `Open tools`: the button was unstable, then hidden, until the 15000 ms deadline (`browser-gateway.spec.ts:238`).
- **Evidence:** `orkestrator-test-run.ZDtnJp/merge-real-stack.log.gz` and `orkestrator-test-run.ru93zY/merge-15f6cd-gateway-owner.log.gz` below the host temporary directory; Playwright evidence under `output/agent-testing/merge-15f6cd-gateway-rerun/browser/`.
- **Disposition:** reproduced in the owning file, so this observation does not independently establish a flake. The narrow tools-popover path remains an unresolved validation limitation. No gateway source, assertion, timeout or skip changed. Both disposable profiles were stopped and reset.
