# DesignCanvasTab history > only the focused pane handles a shared shortcut

- **ID:** 0156
- **Status:** resolved
- **Date observed:** 2026-09-22
- **File:** `apps/web/src/components/design/DesignCanvasTab.test.tsx:218`
- **Original command:** `mise run test`
- **Worker configuration:** Four aggregate groups; workspace Turbo concurrency
  two, Bun `--parallel=1` for the web package; eight host slots total.
- **Failure:** `expect(event.defaultPrevented).toBe(true)` received `false`
  (12.29 ms).
- **Suite counts:** Web: 6,943 tests, 6,931 passed, 11 skipped, one failed
  across 312 files (141.21 s). Root, bridges, and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name design-shortcut-rerun -- bun test --cwd apps/web ./src/components/design/DesignCanvasTab.test.tsx --parallel=1 --only-failures`
  passed (all four tests; wrapper duration 0.2 s).
- **Evidence:** Aggregate artifacts in
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.ihh6aD/`,
  specifically `workspace-web-backend-desktop-web-public-cli-protocol.log.gz`.
- **Hypothesis:** The test waits for enabled undo buttons, then dispatches a
  window event outside `act`. The keyboard listener is installed by an effect
  keyed on history availability and busy state. DOM availability may precede
  the corresponding listener update under aggregate load. This is a hypothesis,
  not a confirmed cause; the aggregate also printed act warnings for this
  component. No design-canvas implementation or assertions changed during the
  Codex transcript investigation.
- **Recurrence (2026-09-23):** `mise run test` again received `false` instead of
  `true` at the same assertion (9.93 ms) while validating the ActionBar run-script
  fix. The web workspace group reported one failed test; the owning file passed
  alone with `mise run test:logged -- --name design-canvas-isolated -- bun test
  --cwd apps/web ./src/components/design/DesignCanvasTab.test.tsx --parallel=1
  --only-failures` (0.2 s). Artifact:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.4bbPpy/workspace-web-backend-desktop-web-public-cli-protocol.log.gz`.
- **Recurrence (2026-09-24, Linux):** `mise run test` received `false` at the
  same assertion twice while validating the MCP server management branch
  (`implement-index-plan-244c1f885c7f-r1`), once at 58.59 ms. Web group: 7,174
  passed, one failed; root, bridges and protocol groups passed. The change set
  touches no design-canvas, shortcut or keybinding file. The owning file passed
  alone with `mise run test:logged -- --name design-canvas-alone -- bun
  --cwd=apps/web test ./src/components/design/DesignCanvasTab.test.tsx`.
  Artifact: `/tmp/orkestrator-test-run.QcdF6x/workspace-web-backend-desktop-web-public-cli-protocol.log.gz`.
- **Recurrence (2026-09-26, Linux):** `mise run test` failed this test once
  (49.51 ms) while validating the recurring-processes branch
  (`implement-recurring-processes-aaceef7ccc03-r1`); the web group reported
  7,350 passed, one failed, and root, bridges and protocol groups passed. That
  branch routes the canvas's 3 s cursor safety check through the read
  coordinator but does not touch the keyboard/shortcut path. The same failure
  was also seen in a step 11 worktree with no design-canvas change. The owning
  file passed alone three times with `bun test --cwd apps/web
  ./src/components/design/DesignCanvasTab.test.tsx`. Artifact:
  `/tmp/orkestrator-test-run.9Kr2d5/workspace-web-backend-desktop-web-public-cli-protocol.log.gz`.
- **Recurrence (2026-09-24):** `mise run test` failed the same test again in
  the web workspace group (7,184 tests, 2 failed) during backend-only
  web-annotation work; the owning file passed alone.
- **Recurrence (2026-09-25, Linux):** `mise run test` failed it twice more on
  the web annotations branch (52.94 ms and 71.28 ms), the only failure in the
  web group each time; that change touches no design-canvas, shortcut or
  keybinding file. The owning file passed alone with `mise run test:logged --
   --name design-canvas-alone -- bun --cwd=apps/web test
   ./src/components/design/DesignCanvasTab.test.tsx`.

## Resolution (2026-09-30)

Already fixed in product code; this entry was never closed. The hypothesis
above was right, and it was a real product bug. Before #844 the canvas kept
`history` and `busy` in React state, and the async sync loop set them
(`setHistory(nextHistory)`, a default-priority update). The Undo button's
`disabled={!canvas || busy || !history.canUndo}` reached the DOM at commit.
The window keydown listener, however, was a `useEffect` whose closure captured
`history` and `busy`. React flushes that effect in a later scheduler task, so
between the commit and that task the listener still saw `canUndo === false`
and never called `preventDefault()`. A user pressing Ctrl/Cmd+Z in that window
got a no-op.

#844 (`8f5d8041`, 2026-09-25) rebuilt the canvas. The handler now reads
`projectionRef.current?.workspace?.history` when the key is pressed. The ref is
assigned during render from the same `projection` that enables the toolbar
button, so the listener cannot lag the DOM. The test is now
`DesignCanvasTab > shortcuts route to design undo only for the owning pane and
never from text fields`, and its assertion is unchanged.

Every commit that recorded a failure here lacks `8f5d8041`: `23ef8fbf`,
`8fa8c26b`, `173b94a8`, `366b3f74`, `9767f061`, `17e021e8`, `964d71f4` and
`9fc48656`. So does branch commit `4cda1722`, from the 2026-09-26 run. This was
checked with `git merge-base --is-ancestor`. A recurrence on code containing
#844 would be a new mechanism; check the aggregate log first for an uncaught
React error that unmounted the root.
