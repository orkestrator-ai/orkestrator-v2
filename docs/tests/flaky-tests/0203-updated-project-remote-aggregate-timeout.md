# 0203 — Updated project remote aggregate timeout

- **ID:** 0203
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `Electron backend command registry > new environments use an updated project remote when created and started`
- **Owning file:** `apps/backend/tests/commands-integration.test.ts:1531`
- **Original command:** `mise run test:logged -- --name clone-aggregate -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- **Worker configuration:** Root group `--parallel=3`; workspace and bridge groups use two package tasks with one worker each. A focused backend test and browser validation also overlapped initially.
- **Failure:** Timed out after 5000 ms (reported duration 5001.69 ms); one dangling fixture process was killed.
- **Root suite counts:** 5014 passed, 2 failed, 24 skipped across 253 files. One subsequent unhandled ENOENT came from this timed-out test attempting to read its already-cleaned fake-Docker log at line 1578. The other failure was the DOM-assertion scanner detecting new assertions; those assertions were corrected and its owning file passed afterward.
- **Isolated rerun:** `mise run test:logged -- --name clone-command-integration-rerun -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures` → passed, exit 0, 24.5 seconds. The owning file was unchanged.
- **Evidence:** `/private/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.WohGHa/root-and-agent-support-tests.log.gz` and its `summary.json`.
- **Hypothesis:** The unchanged fixture passed alone, consistent with a load-sensitive timeout in real Git/process operations. The evidence does not establish a product defect or a specific timing cause. No test was skipped, loosened, or changed to hide the failure.

## Final validation — 2026-10-13

`mise run test:logged -- --name clone-final-aggregate -- mise run test`, with the same GNU-tool PATH, passed all four groups (exit 0, 373.6 seconds). The root group passed in 171.2 seconds. The fixture remains unchanged; this successful rerun does not establish a fix for the load-sensitive timeout.
