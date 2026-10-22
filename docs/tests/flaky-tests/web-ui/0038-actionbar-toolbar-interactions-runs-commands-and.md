# `ActionBar toolbar interactions > runs commands and opens the editor from keyboard shortcuts` (`apps/web/src/components/layout/ActionBar.test.tsx:1704`)

- **ID:** 0038
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside `@orkestrator/web:test:workspace`, 5,095 tests across 222 files in 118.5 s.
- **Failure:** a mock assertion reporting the expected call arguments followed by `But it was not called.` (duration: 47.14 ms).
- **Suite counts:** web workspace group — 1 skipped, 1 failed; the root, bridges, and codex-protocol-lockfile groups all passed.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` → 171 passed in 17.3 s. Also passed under `--parallel=4` (16.0 s), and passed on a stashed working tree at `4d25c8ea` with no local changes, so it is not attributable to the branch under test.
- **Recurrence (action-bar launch-dialog defaults review, 2026-08-24):** `bun run test:logged -- --name web-package-tests2 -- bun --cwd=apps/web test --parallel=4 --only-failures` reproduced the identical signature at `ActionBar.test.tsx:1767` — `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })` followed by `But it was not called.` (duration: 48.19 ms), matching the 47.14 ms original. Web package: 1 failed across 232 files, 5,327 tests in 45.88 s. Two immediate re-runs of the same command passed (45.7 s), and the isolated rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed 187/187 in 16.20 s. The reviewed change adds tests to the same file but only below line 4340, so it cannot reorder or affect this case, which sits at line 1752. Evidence: `web-package-tests2.log.gz` in the run's `orkestrator-test-run.*` log directory.
- **Recurrence (pi reconnect review, 2026-08-25):** `bun run test:logged -- --name full-suite-final -- bun run test` failed the web workspace group on the same assertion in a *different* case in the same file — `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5089`, `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })` (duration: 45.81 ms). The mock had recorded three calls (`plain`, `agent-native`, `codex`), so the earlier shortcuts in the sequence did fire and only the one under assertion was missed, which fits the handler-installation hypothesis below rather than a wholesale failure to mount. Web package: 5,375 passed, 1 skipped, 1 failed across 232 files in 66.62 s. The isolated rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed 188/188, and a full re-run of `bun --cwd=apps/web test --parallel=4 --only-failures` passed in 32.8 s. An earlier `bun run test` on the same branch passed this group outright. Evidence: `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under `/var/folders/.../orkestrator-test-run.PHvwPq`.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** `bun run test`
  failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` after 26.31 ms. The web workspace
  group reported 5,379 passed, 1 skipped, and 1 failed across 232 files. The
  isolated rerun,
  `bun test ./src/components/layout/ActionBar.test.tsx --only-failures` from
  `apps/web`, passed all 189 tests in 12.37 s.
- **Recurrence (Cursor SDK-only migration, 2026-08-26):** `bun run test`
  failed the same keyboard-shortcut case after 23.36 ms on
  `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands:
  ["bun test"] })`. The mock contained the preceding plain, native-agent, and
  review-tab calls, but not the run-command call. The web workspace group
  reported 5,466 passed, 1 skipped, and 3 failed across 236 files; the other two
  failures were stale Cursor CLI expectations fixed in the same change. The
  isolated rerun `bun test src/components/layout/ActionBar.test.tsx` from
  `apps/web` passed all 190 tests with 728 assertions in 12.84 s, including the
  target in 14.89 ms.
- **Recurrence (retry-gate review follow-up, 2026-08-25):** the same case failed
  again on the next `bun run test` for that branch, at `ActionBar.test.tsx:5170`
  after 51.07 ms, alongside `opens the Resolve modal after a mobile long press
  without launching a default resolve` in the same file. The web workspace group
  reported 5,393 passed, 1 skipped, and 2 failed across 233 files. The isolated
  rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  passed 189/189 in 14.54 s. Two distinct cases in one file failing together,
  both of which pass alone, points at the whole file losing its wall-clock
  budget rather than at either assertion.
- **Recurrence (control MCP review fixes, 2026-08-26):** `bun run test` failed
  `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow,
  editor, and panel shortcuts` at `ActionBar.test.tsx:5170` after 23.68 ms. The
  expected `createTabMock("plain", { initialCommands: ["bun test"] })` call was
  absent even though the mock recorded the preceding plain, native-agent, and
  Codex tab calls. The web workspace group reported 5,439 passed, 1 skipped,
  and 1 failed across 235 files in 63.11 s; the other aggregate groups passed.
  The isolated rerun
  `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --timeout 30000`
  passed 189/189 in 12.79 s, with the target case completing in 14.64 ms. The
  reviewed change only replaces ActionBar's tab-cap literal source with a shared
  constant whose value remains 9; it does not touch run-command loading or the
  shortcut payload. Evidence: the `workspace-web-backend-desktop-web-public-cli-protocol`
  log under `/var/folders/.../orkestrator-test-run.qXZvbG`.
- **Recurrence (Multi Review fix transcript follow-up, 2026-08-27):** `bun run
  test` failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5212` after
  27.81 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent, while the mock recorded the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,507 passed, 1 skipped, and 1 failed across 240 files in 69.45 s; the root,
  bridges, and protocol-lockfile groups passed. The isolated rerun `bun test
  src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`
  passed all 190 tests with 727 assertions in 14.47 s. The reviewed change does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.IB45Lu`.
- **Recurrence (backend environment naming, 2026-08-27):** a second `bun run
  test` failed the same keyboard-shortcut case at `ActionBar.test.tsx:5450`
  after 30.31 ms. The expected run-command call was absent while the mock again
  contained the preceding plain, native-agent, and Codex review-tab calls. The
  web workspace group reported 5,531 passed, 1 skipped, and 1 failed across 242
  files; the other three top-level groups passed. The immediate isolated rerun,
  `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`, passed
  198/198 with 770 assertions in 14.59 s; the target passed in 21.45 ms. The
  environment-naming change does not touch `ActionBar`, its shortcut handler,
  or run-command loading.
- **Recurrence (Multi Review teardown review fixes, 2026-08-27):** `bun run
  test` failed the same keyboard-shortcut case at `ActionBar.test.tsx:5452`
  after 23.84 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,543 passed, 1 skipped, and 1 failed across 242 files in 68.29 s; the backend
  workspace and every other full-suite group passed. The isolated rerun `bun
  test src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`
  passed all 198 tests with 770 assertions in 14.85 s. The reviewed change does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.CkFtcL`.
- **Recurrence (agent messaging implementation, 2026-08-28):** `bun run test`
  failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5452` after
  14.06 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,561 passed, 1 skipped, and 1 failed across 243 files in 66.17 s; the
  backend workspace and the root, bridge, and protocol-lockfile groups passed.
  The immediate isolated rerun, `bun test
  src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`,
  passed all 198 tests with 770 assertions in 14.81 s. The implementation does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.qqfO2R`.
- **Recurrence (agent messaging review fixes, 2026-08-28):** `bun run test`
  failed the same keyboard-shortcut case at `ActionBar.test.tsx:5452` after
  24.89 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,572 passed, 1 skipped, and 1 failed across 245 files in 65.61 seconds; the
  backend workspace and the root, bridge, and protocol-lockfile groups passed.
  The immediate isolated rerun, `bun test
  src/components/layout/ActionBar.test.tsx` from `apps/web`, passed all 198
  tests with 772 assertions in 14.27 seconds. The review fixes do not touch
  ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.KTh5f2`.
- **Recurrence (feature activation, 2026-08-29):** `bun run test` failed the
  same `dispatches tab, workflow, editor, and panel shortcuts` case at
  `ActionBar.test.tsx:5467` after 118.84 ms. The expected run-command call was
  absent while the mock again contained the preceding plain, native-agent, and
  Codex review-tab calls. The web workspace reported 5,577 passed, 1 skipped,
  3 failed, and 1 trailing error across 5,581 tests; the aggregate runner also
  stretched unrelated timer cases into multi-minute durations. The isolated
  rerun `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`
  exited 0 against the same tree.
- **Recurrence (colour-scheme adoption, 2026-08-30):** `bun run test` failed
  the same `dispatches tab, workflow, editor, and panel shortcuts` case at
  `ActionBar.test.tsx:5467` after 19.56 ms. The expected `createTabMock("plain",
  { initialCommands: ["bun test"] })` call was absent while the mock again
  contained exactly the preceding plain, native-agent, and Codex review-tab
  calls (`Number of calls: 3`). The web workspace group was the only failing
  group besides two palette assertions fixed in the same change; the bridge and
  protocol-lockfile groups passed. The immediate isolated rerun, `bun
  --cwd=apps/web test src/components/layout/ActionBar.test.tsx`, passed all 198
  tests with 773 assertions in 14.12 s. The reviewed change restyles the
  toolbar's Create PR placement and the shared button variants but does not
  touch the shortcut handler or run-command loading. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.pHJVhH`.
- **Hypothesis:** The case dispatches a keyboard shortcut and asserts the resulting command mock synchronously. Under renderer contention the React commit that installs the shortcut handler can land after the key event is dispatched, so the handler never runs. A recurrence should wait for the control the shortcut targets to be mounted before dispatching, rather than relaxing the call assertion.
