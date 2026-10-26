# NativeAgentService healthy-commit test timed out under aggregate load

- **ID:** 0950
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `NativeAgentService > commits a healthy environment while another environment's provider fails`
- **File:** `apps/backend/src/core/native-agent-service-base.test.ts:2267`
- **Change under test:** todo 0145 (Claude Linux sandbox probe), which touches neither this owner nor its subject.
- **Original command:** `mise run test` on macOS, Bun 1.4.4, branch `todo-0145-claude-linux-sandbox-39a58b878dd6` (head `4c54d788e`), with other worktrees validating on the host (load average about 21).
- **Aggregate result:** timed out after 5,000 ms (5093.73 ms reported) in the backend workspace group; two other backend tests in unrelated files timed out the same way in the same run (0951, 0621).
- **Unchanged owner rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-base.test.ts --parallel=1` passed (67 pass, 0 fail).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pHWGe9` (the run's failure artifacts).
- **Hypothesis:** host load stretched the test past Bun's five-second default. Unproven; no implementation, assertion, timeout or skip changed.
