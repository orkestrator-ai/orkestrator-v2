# Electron nickname snapshot after renderer reload

- **ID:** 0515
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `remote nicknames refresh all native titles and Window menu entries`
- **File:** `e2e/agent-testing/electron-main.spec.ts:576`
- **Original command:** `mise run test:logged -- --name review-electron -- mise run test:agent:electron`.
- **Worker configuration:** the repository Electron scenario runner, alongside aggregate validation on a busy host.
- **Failure:** the second renderer's connection list did not expose the updated `Workstation` nickname within the five-second poll after reload (line 452). The full scenario run reported 21 passed, 1 skipped, 1 failed.
- **Isolated reruns:** the first targeted retry also failed. A diagnostic retry passed; the temporary diagnostics were removed, and the unchanged exact test passed again in `review-electron-confirm` (8.8 s).
- **Evidence:** private scenario output under the `nodes-review-electron-confirm` output directory; logged runner names above.
- **Hypothesis:** renderer reload and shared connection snapshot hydration can exceed the poll deadline under concurrent load. This is a later assertion than the startup symptom recorded in 0470. No assertion, timeout, or skip was changed.
- **Recurrence 2026-10-25:** failed in the full `test:agent:electron` run on branch `todo-0044-annotation-qualification-55474f22f1aa` (shared macOS desktop, load about 45) and again alone, both with the branch's code and with its desktop changes reverted to `ba7cc8d4`; the branch does not touch nickname or Window-menu code.
