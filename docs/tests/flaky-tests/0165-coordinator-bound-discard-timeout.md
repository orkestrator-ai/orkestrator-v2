# Coordinator bound discard confirmations timeout under aggregate load

- **ID:** 0165
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `project coordinator > bound discard confirmations refuse stale, sequencer, nested, and failed switches`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test` on branch
  `implement-improvements-ecf7c41c13cd-r1` (inconsistency remediation; the
  coordinator service and its close paths are not changed by this branch)
- **Worker configuration:** workspace group (2 worker slots) concurrent with
  the root, bridges and codex-protocol groups. The workspace group took 742.3 s,
  against 399.0 s for the same group earlier on this branch, so the host was
  unusually loaded.
- **Failure:** the test failed at 5111.35 ms (bun's five-second default
  timeout). No assertion message was reported. Root, bridges and
  codex-protocol groups passed in the same run.
- **Isolated rerun:**
  `mise run test:logged -- --name coordinator-rerun-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed three times in a row (14.8 s, 12.0 s, 10.6 s for the whole file).

## Current assessment

A timeout under aggregate load, the same shape as 0151 and 0155. The test runs
several sequential confirmation switches inside one five-second budget. Keep
open until a recurrence shows whether it needs a larger explicit timeout or a
cheaper fixture.
