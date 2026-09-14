# `EnvironmentSettingsDialog > uses top agent tabs and shows MCP servers, plugins, and skills for each agent` (`tests/unit/components/EnvironmentSettingsDialog.test.tsx`)

- **ID:** 0072
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-full-tests.log`
- **Worker configuration:** the root and agent-support group ran as `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel=4` (`4x PARALLEL`).
- **Failure:** `expect(received).toEqual(expected)` at `EnvironmentSettingsDialog.test.tsx:304` — expected `["Claude", "Codex", "OpenCode"]`, received those plus `"Rendered"` and `"Raw"` (duration: 15.27 ms).
- **Suite counts:** root and agent-support group: 3,639 total, 3,637 passed, 1 skipped, 1 failed; the workspace, bridges, and codex protocol lockfile groups passed.
- **Isolated rerun:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` -> 20 passed, 0 failed in 471 ms.
- **Root cause:** the assertion used the document-wide `screen.getAllByRole("tab")`, so it matched every element with `role="tab"` in the worker's shared happy-dom document, not only the dialog's own tablist. `"Rendered"` and `"Raw"` are the view tabs rendered by
  `apps/web/src/components/markdown/MarkdownEditorTab.tsx`; a sibling file that ran earlier in the same worker left them mounted. The leak is pre-existing, but the native-agent consolidation deleted ten large test files, which redistributed files across workers and paired this file with a leaking neighbour for the first time.
- **Fix:** scope the query to `screen.getByRole("tablist", { name: "Agent extensions" })` so the assertion can only observe this dialog's tabs. The `aria-label` was already present on the `TabsList`.
- **Verification:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` and a full `bun run test` after the fix; see the run recorded alongside the native-agent projection changes.
