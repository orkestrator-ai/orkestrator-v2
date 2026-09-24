# DesignCanvasTab history > only the focused pane handles a shared shortcut

- **ID:** 0156
- **Status:** open
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
