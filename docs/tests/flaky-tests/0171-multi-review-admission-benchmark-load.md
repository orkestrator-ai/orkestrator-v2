# Multi Review admission benchmark exceeds its limit under aggregate load

- **ID:** 0171
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `Multi Review control-plane benchmark > one slow reviewer does not serialize the rest of the panel`
- **File:** `apps/backend/src/core/multi-review-efficiency.bench.test.ts:444`
- **Original command:** `mise run test`, while other worktrees were also testing on the host.
- **Failure:** `result.admissionMs` was 330 ms; the assertion required less than 310 ms.
- **Isolated rerun:** `mise run test:logged -- --name backend-multi-review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures` passed.
- **Second aggregate run:** `mise run test` passed all four groups, including the workspace group.

## Current assessment

The benchmark is sensitive to host load. The backend code did not change in this task. Investigate the timing budget and host contention before changing the limit.
