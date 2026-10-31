# Workspace setup untracked-cache check got a null subprocess status at the deadline

- **ID:** 1532
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `workspace setup Git scan caches > enables the untracked cache inside a repository`
- **File:** `tests/unit/workspace-setup-preserve.test.ts:190`
- **Original command:** the container-state main merge aggregate,
  [0751](../aggregate-validation-runs/0751-container-state-main-merge-validation.md)
  (`mise run test`, reservations 4/1/2/1, beside component browser, Electron
  and Docker checks).
- **Failure:** null subprocess status at the five-second deadline (5,035.03 ms).
- **Isolated rerun:** `mise run test:logged -- --name merge-workspace-setup-owner -- bun test ./tests/unit/workspace-setup-preserve.test.ts --parallel=1 --only-failures`
  passed, exit 0, 14.3 s logged.
- **Hypothesis:** a real `git` subprocess slowed past the default deadline
  under host load. Not established. Created on 2026-10-31 from the 2026-10-25
  triage in todo 0030, which named this owner without a case. Next
  recurrence: record host load and the subprocess's own duration; if it is
  load, give the case an explicit budget rather than the default.
