# `SkillsSettings > clears the copied confirmation when its timer expires` (`apps/web/src/components/settings/SkillsSettings.test.tsx:759`)

- **ID:** 0024
- **Status:** resolved
- **Date observed:** 2026-09-11
- **Original command:** `bun --cwd=apps/web test src --parallel --only-failures`
- **Worker configuration:** the web package ran `bun test src --parallel` with
  Bun's default parallel worker pool (282 files, 6,354 tests).
- **Failure:** the case was reported failed after 383.79 ms in the same run that
  failed the sibling clipboard case above. Raw console output was retained but no
  assertion detail was, because the aggregate output exceeded the capture budget.
- **Suite counts:** 6,341 passed, 11 skipped, 2 failed.
- **Isolated rerun:** `bun --cwd=apps/web test
  src/components/settings/SkillsSettings.test.tsx` -> 45 passed, 0 failed, 2.8 s.
- **Attribution:** the change in flight touches coordinator caveat rendering in
  `AgentModelPicker`/`CoordinatorPanel` and cannot reach `SkillsSettings`.
- **Hypothesis:** like the sibling case, this waits on the component's real
  copy-confirmation timeout; the web suite is dominated by real-timer waits, so
  a slow worker starves the deadline. A recurrence should retain the assertion
  detail before changing the timeout or expectation.

## Resolution (2026-09-18)

The focused reproduction retained the missing-button assertion: this case
failed once in a 50-repetition run before its fake-timer checks began. The
component's passive selection-reset effect could run after the clipboard
promise and clear the confirmation. Moving that reset to the commit-time layout
phase and rejecting stale clipboard completions fixes the race without changing
the 1.5-second product timeout or loosening the assertions. The four clipboard
cases passed 200/200 under repetition, and the complete 46-test owner passed.
