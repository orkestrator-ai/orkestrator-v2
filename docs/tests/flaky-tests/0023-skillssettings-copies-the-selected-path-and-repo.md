# `SkillsSettings > copies the selected path and reports clipboard failures` (`apps/web/src/components/settings/SkillsSettings.test.tsx:730`)

- **ID:** 0023
- **Status:** open
- **Date observed:** 2026-08-28; recurred 2026-09-11
- **Original command:** `bun run --cwd apps/web test`
- **Worker configuration:** the web package ran `bun test src --parallel` with
  Bun's default parallel worker pool.
- **Failure:** the case was reported failed after 83.61 ms. The aggregate output
  exceeded the capture budget before the assertion detail was retained.
- **Suite counts:** 5,570 total, 5,568 passed, 1 skipped, 1 failed across 244
  files in 23.95 s.
- **Isolated rerun:** `bun --cwd=apps/web test
  src/components/settings/SkillsSettings.test.tsx` -> 45 passed, 0 failed; the
  target passed in 1,572.97 ms.
- **Hypothesis:** the test waits for the component's real copy-confirmation
  timeout to restore the button before exercising the rejection path. Its
  aggregate-only failure and much longer successful isolated duration establish
  timing sensitivity, but the missing assertion detail does not identify a
  narrower cause. A recurrence should retain that assertion before changing the
  timeout or expectation.
- **Follow-up:** an immediate rerun of `bun run --cwd apps/web test` passed all
  5,569 active tests with 1 skipped across the same 244 files in 23.54 s.
- **Recurrence (2026-09-11):** `bun --cwd=apps/web test src --parallel
  --only-failures` reported 6,341 passed, 11 skipped, 2 failed across 6,354
  tests in 282 files (52.06 s). Both failures were timer sensitive and in this
  file: this case (273.25 ms) and `clears the copied confirmation when its timer
  expires` (383.79 ms, entry below). The owning file rerun alone passed (45
  cases). The change in flight touches the coordinator caveat's placement in
  `AgentModelPicker` and cannot reach `SkillsSettings`, so this is recorded as a
  recurrence of the aggregate/parallel timing flake rather than a regression.
