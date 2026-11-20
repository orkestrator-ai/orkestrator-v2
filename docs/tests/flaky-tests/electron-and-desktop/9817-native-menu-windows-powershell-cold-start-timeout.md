# Native menu on Windows: the first PowerShell call timed out on a cold start

- **ID:** 9817
- **Status:** open
- **Date observed:** 2026-11-20
- **Base commit:** `627bdc500` for the investigation; observed on the 2.39.10-beta release pull request.
- **Test:** `built application menu resolves native roles and dispatches callbacks`
- **File:** `e2e/agent-testing/application-menu-electron.spec.ts:122` (helper `e2e/agent-testing/native-menu-input.ts:9`)
- **Original command:** CI pull-request run 44765924296 (#2515, `release/v2.39.10-beta`), workflow "Native application menu", job "Native menu (windows-latest)" 136390385977, the `native-menu-windows` logged run.
- **Worker configuration:** GitHub `windows-latest` runner, one worker, five repetitions of each case (15 tests in the run).
- **Failure:** `Error: spawnSync powershell.exe ETIMEDOUT` from `nativeMenuWindows` (`native-menu-input.ts:23`), called at `application-menu-electron.spec.ts:261`. It failed on the first repetition of the case (`[2/15]`), which makes the run's first PowerShell call. All later repetitions of the same case passed: 14 passed, 1 failed (84.9 s).
- **Isolated rerun:** not run. The case needs a Windows desktop, and the branch was prepared on a headless Linux host.
- **Recurrence check:** not in the registry before. 9929 (same workflow, Windows) is a different symptom: Electron closing after DevTools opened.
- **Root cause (evidence-backed hypothesis):** `powershell()` gave every call a 10 s `execFileSync` budget. The first call starts PowerShell and loads .NET and the UIAutomation assembly (`Add-Type -AssemblyName UIAutomationClient`), which is much slower than any later call. That only the first repetition failed fits a cold start, not a hung window lookup.
- **Fix (branch `fix-ci-round-3-8ad0c62eed90`):** the budget is now 45 s, with a comment saying why. A real hang still fails, well inside the 120 s test timeout.
- **Verification:** none yet. Close this case once "Native menu (windows-latest)" passes with the change.
