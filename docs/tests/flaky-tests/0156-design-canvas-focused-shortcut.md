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
