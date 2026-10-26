# surviving owned descendants fail shutdown verification and are terminated before profile removal

- **ID:** 1011
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `surviving owned descendants fail shutdown verification and are terminated before profile removal`
- **File:** `tests/unit/design-qualification-processes.test.ts:221`
- **Original command:** `mise run test`, root/support group with one worker, concurrent workspace and bridge groups.
- **Failure:** The descendant PID remained zero instead of being greater than zero (417.90 ms).
- **Suite counts:** 3,520 root/support passes, four failures, one error; 3,524 tests across 170 files.
- **Isolated rerun:** `mise run test:logged -- --name design-process-owner -- bun test ./tests/unit/design-qualification-processes.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file (7.6 s).
- **Evidence:** `orkestrator-test-run.pk3f2Z` below the host temporary directory.
- **Hypothesis:** Process discovery may race fixture startup under aggregate load; the unchanged full owner passes alone. Not confirmed; no assertion, timeout or skip changed.
