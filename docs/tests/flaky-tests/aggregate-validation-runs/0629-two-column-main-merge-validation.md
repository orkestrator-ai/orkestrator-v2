# Two-column report main-merge validation

- **ID:** 0629
- **Status:** open
- **Observation date:** 2026-10-21
- **Scope:** merge of `40dd964b10d8410282ab1bef8b18640db4e73017` into pre-merge HEAD `3f55e36ca21b428f7bc154c06c096f7721c8e7db` on `two-column-layout-82d8d20def9e-r1`.
- **Original commands:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`; `ORKESTRATOR_E2E_PORT=21492 ORKESTRATOR_PUBLIC_E2E_PORT=24492 mise run test:logged -- --name merge-browser-own-port -- mise run test:browser`; credential-free `test:agent:browser:isolated`; `test:agent:electron`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1, two package workers and one root/bridge worker; component browser defaults, isolated browser and Electron one worker. Other worktrees shared the host. Workspace admission waited 605.9 seconds; root admission waited 523.8 seconds. A detached earlier test run in this same checkout was interrupted through its runner after confirming its ownership and disconnected output.

## Aggregate observations

- Component browser: 377 passed, 81 skipped, 20 failed (732.5 seconds logged). Failures were in `BackgroundTaskOutcome`, `AgentUsage`, `CoordinatorPaneTree`, `DesignCanvas`, `MultiReviewFlow`, `PaneBreakpoint`, `NativeHeldSend`, `SetupRecovery`, `TerminalCornerToolbar`, `GlobalStyles`, and `MonacoRuntime`. The report-layout boundary and wrapping cases passed.
- Public-site browser: six passed, two mobile navigation failures; complete unchanged owner passed with one worker (`merge-public-owner`, 30.2 seconds).
- Electron: 27 passed, one skipped, two failed (597.6 seconds). The nickname reload missed `Workstation` within five seconds; multi-backend preview attachments missed the expected count within five seconds. The complete unchanged `electron-main.spec.ts` and `service-preview-electron.spec.ts` owners passed (`merge-electron-main-owner`, 60.1 seconds; `merge-preview-owner`, 99.6 seconds).
- Isolated browser: 27 passed, 42 skipped, two failed (791.2 seconds). Narrow host-path selection kept the SSH socket selection disabled; the design-canvas synchronization case also failed. The complete unchanged design owner passed in a fresh disposable profile (`merge-design-owner`, 72.5 seconds).
- Root/support: 3,185 passed, one skipped, two failed and one error across 3,188 tests in 151 files (422.78 seconds). Pi runtime staging exceeded 30 seconds; disk reporting exceeded five seconds (5,027.73 ms). The complete unchanged disk owner passed (`merge-disk-owner`, 4.4 seconds).
- Bridges: ACP's filesystem/terminal generalization case hit its 60-second hook deadline (60,013.01 ms); the complete unchanged owner passed with the matching Node preload (`merge-acp-owner`, 1.6 seconds). The other four bridge packages passed.
- Workspace observations included desktop lifecycle exit timing and artifact-shell rate bounds, both of whose complete unchanged owners passed with the matching Node preload (`merge-backend-lifecycle-owner`, 0.2 seconds; `merge-artifact-shell-owner`, 0.1 seconds). The long transcript fixture exceeded 120 seconds (120,789.83 ms); its complete unchanged owner passed (`merge-long-transcript-owner`, 23.5 seconds).

The full non-iOS suite completed in 1,279.6 seconds logged with six failed
tests across workspace, root/support and bridges. Every failed owning file
later passed unchanged in a focused rerun. The backend passed 9,907 tests
with 68 skips; protocol, public web, CLI and toolchain packages passed.
Formatting, lint (571 existing warnings, zero errors), typechecking, the
production desktop build, frozen installs, flake-registry consistency and
changed-document local-link checks passed. The eight report-layout browser
cases passed at mobile and desktop sizes.

Credentialed provider turns, a dedicated Docker lifecycle suite and iOS were
not selected: the merge adds no Docker lifecycle or iOS implementation change,
and live billed-provider qualification remains opt-in. The credential-free
isolated browser suite reports its unavailable scenarios as skips. All
isolated profiles created for this validation were stopped and reset.

## Component owning-file reruns

All eleven complete unchanged owners passed separately with one worker:
`BackgroundTaskOutcome` (50.0 s), `AgentUsage` (30.5 s),
`CoordinatorPaneTree` (30.9 s), `DesignCanvas` (25.5 s), `MultiReviewFlow`
(96.5 s), `PaneBreakpoint` (24.8 s), `NativeHeldSend` (13.8 s),
`SetupRecovery` (7.0 s), `TerminalCornerToolbar` (15.9 s), `GlobalStyles`
(8.9 s), and `MonacoRuntime` (4.1 s). No product or test source changed.

## Remaining limitations

- Pi runtime staging also timed out in the first unchanged complete owning-file rerun (`merge-pi-owner`, 30,002.17 ms; three passed, one failed; 31.6 seconds logged). After the browser reruns ended, the final complete unchanged owner passed (`merge-pi-final-owner`, four tests, 11.6 seconds). This confirms an intermittent recurrence; see 0178.
- The complete unchanged gateway owner in a fresh profile still failed the narrow host-picker case, this time because Repository settings was hidden/unstable for 15 seconds (14 passed, nine skipped, one failed; 196.0 seconds logged). This remains unresolved. See 0224. The owner profile and the original isolated profile were stopped and reset by the runner.
- No assertion, deadline, retry count or skip was changed. Shared-host contention is plausible for the cases that passed unchanged owners, but is not proven.

## Evidence

All `orkestrator-test-run.*` paths below are under the host temporary directory.

- Full suite outer log: `orkestrator-test-run.MhnQFK/merge-full-tests.log.gz`; inner groups: `orkestrator-test-run.iGsBvL/`.
- Component aggregate: `orkestrator-test-run.tELNMN/merge-browser-own-port.log.gz`.
- Electron aggregate: `orkestrator-test-run.LOpc08/merge-electron.log.gz`; screenshots/traces under `output/agent-testing/merge-electron-82d8/`.
- Isolated browser aggregate: `orkestrator-test-run.3XLLNX/merge-isolated-browser.log.gz`.
- Persistent gateway owner: `orkestrator-test-run.dpfFj2/merge-gateway-owner.log.gz`.
- Persistent Pi owner: `orkestrator-test-run.EXES7p/merge-pi-owner.log.gz`.
- Public-site aggregate: `orkestrator-test-run.YWWQDo/merge-public-browser.log.gz`.
- Component owners run separately with `ORKESTRATOR_E2E_PORT=21492 mise run test:logged -- --name merge-owner-<stem> -- bunx playwright test --config e2e/playwright.config.ts e2e/<stem>.spec.ts --workers=1`; per-owner results are retained in `output/agent-testing/merge-validation-82d8/component-owner-results.json`.
