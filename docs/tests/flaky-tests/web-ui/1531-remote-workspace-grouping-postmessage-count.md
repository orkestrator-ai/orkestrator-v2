# Remote workspace grouping delivery posted five messages instead of none

- **ID:** 1531
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** the grouping-delivery case near the then line 819 (now
  `browser grouping delivery uses the current workspace envelope and survives grant replacement`, line 894, or its neighbour at 870)
- **File:** `apps/web/src/components/federation/RemoteWorkspaceRegion.test.tsx`
- **Original command:** the environment-list main merge aggregate,
  [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md).
- **Failure:** grouping delivery saw five `postMessage` calls instead of zero
  at line 819 (23.04 ms).
- **Isolated rerun:** the unchanged owner passed alone
  (`merge-remote-workspace-owner`, 2.7 s).
- **Related:** [1248](../aggregate-validation-runs/1248-project-landing-tab-review-validation.md)
  saw a different failure in this owner (a missing `boardTab`, 263 ms) while
  an edit was in flight; it was not classified as a flake.
- **Hypothesis:** none. Created on 2026-10-31 from the 2026-10-25 triage in
  todo 0030, which named this owner without a case; the evidence is the 0790
  record, not a new run. Next recurrence: capture which messages were posted
  (their `type`) and whether an earlier test's grant or timer was still live.
