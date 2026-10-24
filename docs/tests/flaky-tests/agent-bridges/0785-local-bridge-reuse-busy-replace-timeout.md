# Local bridge reuse: busy-bridge replacement times out in the aggregate

- **ID:** 0785
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `local bridge reuse under load > replaces a busy bridge that has stayed unresponsive past the grace period`
- **File:** `apps/backend/tests/commands-local-bridge-reuse.test.ts`
- **Original command:** `env -u PORT mise run test:logged -- --name full-test-2 -- mise run test` (todo-0050 branch, rebased on `main` at `71227437`)
- **Worker configuration:** the default aggregate runner (workspace, root, bridges and protocol groups concurrently) on node mbp3 (Mac17,6, 18 cores), with other workspaces keeping the host at load average 17 to 38.
- **Failure:** Bun's five-second generic budget at 5913.03 ms ("this test timed out after 5000ms").
- **Suite counts:** the aggregate finished in 926.5 s; the workspace group also failed on known load timeouts and on the pre-existing OpenCode version expectation in `conformance-execution-policy.test.ts`.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/commands-local-bridge-reuse.test.ts` passed the unchanged owner (9 of 9, 12.0 s).
- **Hypothesis:** the case waits out a real unresponsive-bridge grace period and replacement spawn inside the generic five-second budget, which aggregate load can exceed. The branch touches neither local bridge reuse nor this test (its parent-watchdog change sets how often a bridge checks its parent, not how the backend replaces a busy one). No assertion, timeout or skip changed.
