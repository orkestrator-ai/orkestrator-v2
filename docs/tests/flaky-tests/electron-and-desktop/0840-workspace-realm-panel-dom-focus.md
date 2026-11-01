# Workspace realm panel misses DOM focus under load

- **ID:** 0840
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `a leaf's workspace opens in the window's central region without moving or reloading the window`
- **File:** `e2e/agent-testing/workspace-realm-electron.spec.ts:409`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=e0044-final mise run test:logged -- --name e0044-electron-final -- mise run test:agent:electron` (branch `todo-0044-annotation-qualification-55474f22f1aa`).
- **Worker configuration:** the repository Electron scenario runner on a shared macOS desktop (arktech-mini) at host load about 45 on 18 cores; the window was not key.
- **Failure:** after Enter on the trigger, `panelState` stayed `{ focused: false }` for the opened panel ("Environment process usage" in the full run, "Agent information" in the first rerun) past the five-second poll. The full run reported 31 passed, 1 skipped, 3 failed (the other two were known flakes 0515 and 0622).
- **Isolated reruns:** the exact test failed once and passed once (63 s) with the branch's code; with the branch's desktop changes reverted it passed once. The branch touches no workspace-realm or panel code (its desktop changes are the annotation pin layer, Show on page and a connection-manager log line).
- **Evidence:** `output/agent-testing/e0044-final/electron/results.json`, `e0044-rerun`, `e0044-realm1`, `e0044-realm2`.
- **Hypothesis:** the panel's DOM focus hand-off races the realm view's input routing when the app is not frontmost and the host is saturated, as for the native-focus cases 0271 and 0470. No assertion, timeout, or skip was changed.
- **Resolution (2026-11-01, todo [1170](../../../todo/cross-cutting/1170-electron-native-focus-checks-fail-alone.md)):** not the window or input routing. The realm's coordinator composer mounted while the panel was open and took its DOM focus, through `MentionableInput`'s caret sync (`setCursorOffset`; Chromium focuses a contenteditable that receives the caret) and `useComposerMountFocus`. The coordinator loads after the route upgrade reloads the realm, so on a loaded host it can land under a panel the spec has just opened. Holding the main process's `get_project_coordinator` reads reproduced the exact state. Fixed with `isFocusHeldElsewhere` (`apps/web/src/lib/background-focus.ts`): neither path moves focus out of an open dialog, alert or menu. The spec now forces the race on every run (hold the coordinator, open Agent information, release) and fails with the recorded state if the guard is removed; it passed 4/4 alone afterwards.
