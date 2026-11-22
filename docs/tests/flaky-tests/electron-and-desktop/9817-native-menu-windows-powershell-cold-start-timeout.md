# Native menu on Windows: the first PowerShell call timed out on a cold start

- **ID:** 9817
- **Status:** resolved
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

## Resolution (2026-11-22)

- **Root cause:** `powershell()` in `e2e/agent-testing/native-menu-input.ts`
  gave every call a 10 s `execFileSync` budget, which the run's first call
  (PowerShell start plus the UIAutomation assembly load) could exceed.
- **Fix:** #2519 (`4cc627bf1`) raised the budget to 45 s.
- **Reproduced:** no. The failure needs a cold Windows runner; no Windows host
  was available.
- **Stress:** "Native menu (windows-latest)" passed the `native-menu-windows`
  run (`--repeat-each=5 --retries=0`) in both runs after the fix: 44798394844
  (#2519's own head `7a6a2f0b0`, job 136503831160) and 44825739583 (the
  2.39.11-beta release branch, job 136597746075, 72.2 s), both on
  2026-11-20. Weaker evidence than a reproduction: two cold starts that did
  not time out.
