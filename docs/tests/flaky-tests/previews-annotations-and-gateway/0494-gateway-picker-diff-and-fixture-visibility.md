# Gateway picker, persisted-diff and fixture visibility intermittence

- **ID:** 0494
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `e2e/agent-testing/browser-gateway.spec.ts`.
- **Original command:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`, merging `origin/main` into pre-merge HEAD `f2971d54`, with the credential-free Codex fixture `qa-browser-882fc4e4-937`, one Playwright worker alongside the non-iOS suite, component browser suite and other worktrees.
- **Failures:** the narrow host-picker case at line 147 left `Select file` disabled at line 302; the persisted diff-baseline case at line 2091 failed a visibility assertion. The overall isolated runner reached its fifteen-minute browser deadline after starting 55 of 61 cases (932.4 seconds including startup and cleanup); it stopped and reset its profile. This was an incomplete suite, not a full pass.
- **First owning-file rerun:** fresh fixture `merge-main-gateway-f2971d`, started with `mise run dev:test --profile merge-main-gateway-f2971d --fixture --no-agent-credentials --agent-platforms codex`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-gateway-f2971d ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-gateway-f2971d mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed both original failed cases but failed `real browser gateway exercises an authoritative local environment` at line 505 because the fixture name `origin` never became visible (13 passed, six skipped, one failed; 186.1 seconds logged).
- **Repeated owning-file rerun:** the same command, with run ID `merge-main-gateway-f2971d-repeat` and log name `merge-gateway-owner-repeat`, passed the unchanged whole file (14 passed, six skipped, exit 0; 114.5 seconds logged).
- **Evidence:** `orkestrator-test-run.lTRsMP/merge-agent-browser.log.gz`, `orkestrator-test-run.vBQtie/merge-gateway-owner.log.gz` and `orkestrator-test-run.bxN7uz/merge-gateway-owner-repeat.log.gz` below the host temporary directory; browser traces under `output/agent-testing/<run-id>/browser/`.
- **Cleanup:** the isolated runner stopped/reset its own profile; the owning-file profile was stopped and reset with `dev:stop` and `dev:reset` after the final rerun.
- **Assessment:** the unchanged whole-file pass establishes intermittence for these observations. Host contention and delayed UI reconciliation remain hypotheses. The earlier tools-popover symptom in 0224 is distinct and remains unresolved. No source, assertion, timeout or skip changed.


## Upgrade-channel second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-isolated-browser -- mise run test:agent:browser:isolated`, credential-free Codex profile `qa-browser-75aa6285-358`, one worker. Result: 28 passed, 35 skipped and one failed (exit 1, 430.1 seconds including lifecycle). The narrow host-picker case timed out clicking `Repository settings` at line 238 after 15000 ms; the target became unstable and then hidden.
- **Owning-file rerun:** fresh credential-free profile `qa-merge2-gateway-129e`, started with `mise run dev:test --profile qa-merge2-gateway-129e --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=qa-merge2-gateway-129e ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-gateway-owner ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge2-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1` reported 13 passed, six skipped and one failed (exit 1, 228.0 seconds).
- **Owner result:** the narrow host-picker case passed unchanged. The persisted diff-baseline case at line 2091 instead failed its five-second `vs <tip>` title visibility assertion at line 2182. This is the existing observation tracked by 0494; it is not a new confirmed flaky classification because the owning file did not pass as a whole.
- **Evidence:** `orkestrator-test-run.IadNvo/merge2-isolated-browser.log.gz` and `orkestrator-test-run.HrHKpb/merge2-gateway-owner.log.gz` under the host temporary directory; browser traces under `output/agent-testing/qa-browser-75aa6285-358/browser/` and `output/agent-testing/merge2-gateway-owner/browser/`.
- **Cleanup and disposition:** the one-shot supervisor stopped/reset its profile. The owning-file profile was stopped and reset with `dev:stop` and `dev:reset`, both exit 0; its foreground launcher then exited 143 as requested. Gateway validation remains non-green. No implementation, assertion, deadline or skip changed.


## Keep-open picker agent-mail main merge — 2026-10-19

- **Original command:** the testing guide's macOS GNU-tool PATH prefix with `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`, merging `origin/main` at `ef52cca4` into pre-merge HEAD `75e79aaf`. Credential-free Codex profile `qa-browser-56a177a7-6f5`, one Playwright worker alongside repository/component validation.
- **Failure and counts:** the persisted diff-baseline case at line 2144 missed the `vs <tip>` title at line 2235 after five seconds. The completed browser suite reported 28 passed, 35 skipped and one failed (exit 1, 504.1 seconds including lifecycle). The agent-mail inactive-recipient/reload/retry-key scenario passed.
- **First owning-file rerun:** `mise run dev:test --profile merge-picker-owner-20261019 --fixture --no-agent-credentials --agent-platforms codex`, then `ORKESTRATOR_AGENT_TEST_PROFILE=merge-picker-owner-20261019 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-picker-owner-20261019 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`. The diff-baseline case passed, but the narrow host-picker case at line 147 timed out clicking the unstable/hidden Repository settings button at line 238 (13 passed, six skipped, one failed; exit 1, 122.8 seconds logged).
- **Final owning-file rerun:** the same command and profile, with run ID `merge-picker-owner-repeat-20261019` and log name `merge-gateway-owner-repeat`, passed the unchanged whole file (14 passed, six skipped; exit 0, 116.8 seconds logged).
- **Evidence:** `orkestrator-test-run.0MPp0c/merge-isolated-browser.log.gz` and `orkestrator-test-run.jgPk17/merge-gateway-owner.log.gz` below the host temporary directory; sanitized results and failure artifacts under `output/agent-testing/<run-id>/browser/` for each run above.
- **Cleanup:** the one-shot runner stopped/reset its own profile. The owning-file profile was stopped and reset using `mise run dev:stop --profile merge-picker-owner-20261019` and `mise run dev:reset --profile merge-picker-owner-20261019` (both exit 0); its foreground launcher exited 143 as requested. No live launcher or disposable state was deliberately retained.
- **Assessment:** the unchanged whole-file pass confirms intermittence for these observations. Host contention remains a hypothesis; no implementation, assertion, timeout or skip changed. Component/public-site browser validation, formatting, lint, typechecking and the desktop build passed. The non-iOS aggregate had only the two backend timeout recurrences in [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md) and [0226](../environments-and-containers/0226-deletion-reap-failure-aggregate-timeout.md); both unchanged owning files passed sequentially. Electron, Docker lifecycle, CLI scenario and iOS suites were omitted because those areas did not change; credentialed provider suites kept their opt-ins.


## Agent-test host-home isolation main merge — 2026-10-21

- **Original command:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`, merging `origin/main` at `688f9f69` into `682bd5be` on `fix-agent-test-host-home-writes-c7337a6ddd7f`. Credential-free Codex profile `qa-browser-47085c60-194`, one Playwright worker alongside repository and Electron validation.
- **Failure and counts:** the narrow host-picker case at `browser-gateway.spec.ts:149` timed out after 15,000 ms clicking the unstable, then hidden `Repository settings` button at line 240. Suite result: 28 passed, 41 skipped and one failed; exit 1 after 418.1 seconds including lifecycle. The failed scenario and renderer code were unchanged by the merge; that spec's new changes cover Docker imports.
- **Owning-file rerun:** fresh credential-free profile `merge-browser-rerun`, started with `mise run dev:test --profile merge-browser-rerun --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=merge-browser-rerun ORKESTRATOR_AGENT_TEST_RUN_ID=merge-browser-rerun ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge-gateway-owner-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` repeated the same timeout, with 13 passed, nine skipped and one failed; exit 1 after 124.2 seconds.
- **Assessment:** the symptom matches the previously recorded timeout, but this observation does not independently establish intermittence because the complete owning file did not pass. Browser validation remains non-green. No implementation, assertion, timeout or skip changed.
- **Evidence:** `orkestrator-test-run.YuZ19j/merge-isolated-browser.log.gz` and `orkestrator-test-run.dOhmfb/merge-gateway-owner-rerun.log.gz` below the host temporary directory; sanitized browser evidence under `output/agent-testing/qa-browser-47085c60-194/browser/` and `output/agent-testing/merge-browser-rerun/browser/`.
- **Cleanup:** the one-shot runner stopped/reset its own profile; the owning-file profile was stopped/reset with `dev:stop` and `dev:reset`. No disposable profile state was deliberately retained.


## Design qualification main merge — 2026-10-21

- **Merge and original command:** `origin/main` at `d4171748` into `a3423ada`; `mise run test:logged -- --name merge-browser -- mise run test:agent:browser:isolated`, credential-free profile `qa-browser-c5dc6bca-3dd`, one Playwright worker alongside repository/Electron/Docker validation and other worktrees.
- **Original observations:** the narrow host picker left Select file disabled at line 304 after five seconds; the capped-tree case could not find the build folder at line 776; the move case still reported the old path at line 2358. The one-shot runner reached its 15-minute suite limit and cleaned up its profile, exit 1 after 925.1 seconds. It had reached case 22 of 70, so this is incomplete browser coverage, not a complete three-failure suite result.
- **Focused rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-gateway-rerun-dab5ea29 ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge-gateway-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1 --grep 'host picker creates|capped file tree|local environment move'` reported three passed and one failed, exit 1 in 223.7 seconds. Desktop picker, capped tree and move passed; the narrow picker could not find either drawer button at line 223 within five seconds.
- **Assessment:** the whole owning file was not rerun, and the narrow picker remains failing. This observation does not establish new flaky classifications. The failing scenario code matches main. No assertions, deadlines or skips changed. Shared-host contention remains a hypothesis; load averages exceeded 100 on 18 logical cores.
- **Evidence:** `orkestrator-test-run.D3CX6N/merge-browser.log.gz` and `orkestrator-test-run.itUkmQ/merge-gateway-rerun.log.gz` below the host temporary directory; sanitized artifacts under `output/agent-testing/qa-browser-c5dc6bca-3dd/browser/` and `output/agent-testing/merge-main-gateway-rerun-dab5ea29/browser/`.

- **Cleanup (2026-10-21 merge):** `dev:stop` and `dev:reset` completed for `merge-main-20261021-dab5ea29`, removing two exact-owner containers, four volumes, one network and disposable profile state. The one-shot browser runner stopped/reset its own `qa-browser-c5dc6bca-3dd` profile. No manual profile state was retained.


## Sidebar collision main merge — 2026-10-22

The full isolated browser suite passed its authoritative local-environment smoke
case, but the complete unchanged gateway owner on a fresh credential-free Codex
profile could not find fixture project `origin` at `browser-gateway.spec.ts:521`
within 30 seconds. It also repeated the narrow Repository settings click timeout
(0224): 12 passed, 10 skipped and two failed in 155.3 seconds. This observation
does not establish a new flaky classification. Exact commands and evidence are
recorded in [0224](0224-host-picker-narrow-tools-popover.md#sidebar-collision-main-merge--2026-10-22).
Both disposable profiles were stopped and reset; no owning source or test changed.


## Latest-main refresh of per-machine accounts — 2026-10-24

- **Parents:** merge `e25b6123` and main `553da7f54`.
- **Original command:** `mise run test:logged -- --name update-main-isolated-browser -- mise run test:agent:browser:isolated`, one worker in credential-free Codex profile `qa-browser-bcd7c9c1-ad3`, alongside repository/component suites.
- **Failure:** `capped file tree retains source files and shows incomplete folders after reload` could not find the `build` folder button within five seconds at `browser-gateway.spec.ts:777`, called from line 803. The narrow host-picker case passed in this run.
- **Complete unchanged owner:** fresh credential-free Codex fixture `update-gateway-cb5bcc4a`; `ORKESTRATOR_AGENT_TEST_PROFILE=update-gateway-cb5bcc4a ORKESTRATOR_AGENT_TEST_RUN_ID=update-gateway-cb5bcc4a mise run test:logged -- --name update-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed all fourteen active cases with ten opt-in skips (116.2 s logged), including both picker viewports, capped-tree reload, account recovery and inactive-environment recovery.
- **Evidence:** `orkestrator-test-run.3h0xtJ/update-main-isolated-browser.log.gz` under the host temporary directory after suite completion; original browser artifacts under `output/agent-testing/qa-browser-bcd7c9c1-ad3/browser/`.
- **Assessment:** confirms intermittence in the capped-tree observation on this combined tree. No gateway implementation, assertion, timeout or skip changed during conflict resolution.

- **Full-suite outcome:** 28 passed, 53 opt-in skips and only the capped-tree failure (534.6 s logged including lifecycle). Teardown also rejected an oversized artifact at its sanitization byte limit; this is a separate artifact failure. The one-shot runner stopped/reset `qa-browser-bcd7c9c1-ad3`, and its profile directory was confirmed absent. Manual owner profile `update-gateway-cb5bcc4a` was also stopped and reset; no live profile or disposable state was retained.

- **Recurrence 2026-10-24** (0043 known-limitations branch, node mbp3): `real browser gateway exercises an authoritative local environment` missed the fixture project (`getByText(origin)`, 30 s) in the isolated suite; the same test passed in the owning-file rerun on a fresh profile.

## GitHub HTML main merge — 2026-10-24

- **Parents:** feature `66dd560f9b4414ed57e3450237c2a2735ca4cdc1` and main `d723429d58c52d8290c951fa113625431ad3c3fb`.
- **Original command:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`, one worker in credential-free Codex profile `qa-browser-b4543173-e11`, alongside repository, component and Electron validation.
- **Failure:** the capped-tree case could not find the `build` folder button within five seconds at `browser-gateway.spec.ts:777`. The complete suite reported 28 passed, 54 opt-in skips and one failed; teardown also rejected a trace at its 16 MiB sanitization limit. The command retained exit 1 (543.0 s logged including lifecycle).
- **Complete unchanged owner:** started fresh profile `merge-html-gateway-1024` with `mise run dev:test --profile merge-html-gateway-1024 --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=merge-html-gateway-1024 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-html-gateway-1024 ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed fourteen active cases with ten opt-in skips (122.4 s logged).
- **Evidence:** `orkestrator-test-run.JlHtIe/merge-isolated-browser.log.gz` under the host temporary directory; passing owner summary in `orkestrator-test-run.OKY7fc/summary.json`; sanitized results under `output/agent-testing/qa-browser-b4543173-e11/browser/` and `output/agent-testing/merge-html-gateway-1024/browser/`.
- **Assessment and cleanup:** confirms an intermittent capped-tree recurrence; the original assertion and artifact failures remain explicit. No implementation, assertion, timeout or skip changed. The one-shot runner stopped/reset its profile, and the manual profile was stopped/reset with `dev:stop` and `dev:reset`; both profile directories were confirmed absent.

## Environment-list UI main merge — 2026-10-24

The aggregate recurrence passed in the complete unchanged owning-file rerun. Exact commands, durations, merge parents, aggregate results and evidence are retained in [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md). No implementation, assertion, timeout or skip changed.
