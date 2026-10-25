# `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow, editor, and panel shortcuts` (`apps/web/src/components/layout/ActionBar.test.tsx:5467`)

- **ID:** 0016
- **Status:** resolved
  `ActionBar toolbar interactions > runs commands and opens the editor from keyboard shortcuts`
  (`ActionBar.test.tsx:1704`, observed 2026-08-17, resolved in the 2026-08-27
  sweep and already reopened once as "recurred after the 2026-08-27 resolution
  sweep"). The test has since been renamed and moved; the failing assertion is
  the same line of code, so this continues that history rather than starting a
  new one.
- **Date observed:** 2026-08-31
- **Original command:**
  `bun run test:logged -- --name web-package-tests -- bun --cwd=apps/web test --parallel=4 --only-failures`,
  on `model-selector-theme` (working tree: the shared model-picker theme constant
  and its test).
- **Worker configuration:** four Bun workers on the web package alone, not under
  `scripts/test-all.ts`. No `dev:test` profile was running; the same host had
  just completed a passing run of the identical command.
- **Failure:** `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })`
  at `ActionBar.test.tsx:5467`, after 19.93 ms. `createTabMock` had received
  three calls — `("plain")`, `("agent-native")`, and the `("codex", …)` Review
  tab — so the `Cmd+R` run-commands tab was the only expected call missing.
- **Suite counts:** `5612 pass, 1 skip, 1 fail, 17717 expect() calls. Ran 5614
  tests across 247 files. [40.95s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  -> 198 passed, 0 failed, 773 assertions in 14.86 s.
- **Frequency:** 1 failure in 3 consecutive runs of the identical aggregate
  command on the same host — the run immediately before (at the parent commit)
  and the run immediately after (at the same working tree) both passed the whole
  web package.
- **Hypothesis:** The 2026-08-27 fix added a readiness wait for the accessible
  "Run commands" control before dispatching key events, and that wait is still
  present and did pass here — the earlier mechanism (handler not yet
  subscribed) does not explain this failure, because two other shortcuts in the
  same synchronous block *did* reach `createTabMock`. What distinguishes `Cmd+R`
  is that it is the only one of them fed by `readContainerFileMock`, which the
  test primes with `mockResolvedValueOnce({ content: '{"run":["bun test"]}' })`.
  A single-use mock value is consumed by whichever read arrives first, so any
  additional or reordered `readContainerFile` call under load would leave the
  run-commands state populated from the default mock instead. The evidence
  establishes only that this one asynchronously-fed shortcut was missing while
  its synchronous siblings were not; a recurrence should log every
  `readContainerFileMock` invocation with its arguments before changing the
  assertion, and prefer priming a stable `mockResolvedValue` over a `…Once`
  value if more than one read is observed.
- **Unrelated to the change under test:** neither `ActionBar.tsx` nor
  `ActionBar.test.tsx` references `CreateEnvironmentDialog`, `FeatureBuildFields`
  or `modal-theme`, the only modules that branch touched.
- **Recurrence (file-link fixes, 2026-08-31):** `bun run test` failed the same
  `createTabMock` assertion after 19.50 ms while the workspace group ran with
  two Bun workers (5,637 passed, 1 skipped, 1 failed, 17,769 assertions across
  248 files in 66.40 s); the other three repository groups passed. The immediate
  isolated rerun, `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`,
  passed all 198 tests and 774 assertions in 14.05 s, including the affected
  case in 14.65 ms.
- **Recurrence (backend-owned action jobs, 2026-08-31):** `bun run test` failed
  the renamed backend-job assertion,
  `expect(launchTerminalJobMock).toHaveBeenCalledWith(expect.objectContaining({
  tabType: "plain", data: "bun test\\n" }))`, after 1,017.62 ms while the web
  workspace ran with two Bun workers. The web group reported 5,610 passed, 1
  skipped, and 1 failed across 5,612 tests and 248 files in 64.14 s; the other
  three repository groups passed. The immediate isolated rerun,
  `bun test ./src/components/layout/ActionBar.test.tsx` from `apps/web`, passed
  all 195 tests and 738 assertions in 15.06 s, including the affected case in
  22.22 ms. This change moved the run-command shortcut from renderer tab
  creation to `launch_terminal_job`; the recurrence still isolates to the same
  asynchronously loaded run-command shortcut while the synchronous shortcuts
  in the case pass.
- **Recurrence (Multi Review reviewer-default fixes, 2026-09-01):** `bun run
  test` failed the same `createTabMock` assertion at `ActionBar.test.tsx:5546`
  after 14.84 ms. The mock again contained exactly the preceding plain,
  native-agent, and Codex review-tab calls, with only the asynchronously loaded
  run-command call absent. The web workspace group reported 5,647 passed, 1
  skipped, and 1 failed across 248 files in 64.19 s; the root, bridge, and
  protocol-lockfile groups passed. The immediate isolated rerun, `bun
  --cwd=apps/web test src/components/layout/ActionBar.test.tsx --only-failures`,
  passed all 200 tests with 782 assertions in 14.01 s. This change adds Multi
  Review default resolution and tests in the same file but does not change the
  run-command loader or keyboard-shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.IkAB8E`.
