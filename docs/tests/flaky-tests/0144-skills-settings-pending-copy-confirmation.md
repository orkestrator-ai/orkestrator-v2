# SkillsSettings pending copy confirmation

- **ID:** 0144
- **Status:** open
- **Date observed:** 2026-09-15
- **Test:** `SkillsSettings > drops a pending copy confirmation when the selection changes`
- **File:** `apps/web/src/components/settings/SkillsSettings.test.tsx:976`
- **Original command:** `mise run test`
- **Workers:** web package `--parallel=1`, concurrent aggregate groups.
- **Failure:** after 1,041.67 ms, line 989 could not find the `Skill path copied`
  button. The failure preceded the selection change itself.
- **Suite counts:** web: 6,638 passed, 11 skipped, 2 failed across 294 files in
  252.94 s. The other failure was the existing clipboard flake 0023.
- **Isolated rerun:** the command below passed the owning file in 3.0 s with
  zero failures.
- **Evidence:** `/tmp/orkestrator-test-run.OK3NwX/` (workspace log).
- **Hypothesis:** the missing intermediate clipboard confirmation, shared with
  0023 in the same run, suggests timing or fixture state under the aggregate
  workload. An exact root cause has not been established. The first-prompt
  change does not alter this settings component.

```bash
mise run test:logged -- --name skills-settings-isolated -- \
  bun test --cwd apps/web ./src/components/settings/SkillsSettings.test.tsx \
  --parallel=1 --only-failures
```
