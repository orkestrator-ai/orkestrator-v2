# Backend resource event aggregate timeout

- **ID:** 0503
- **Status:** open
- **Date observed:** 2026-10-19
- **Test:** `OrkestratorBackend resource event wiring > forwards committed prompt and build mutations through the backend emitter`
- **Owner:** `apps/backend/src/core/index-resource-events.test.ts`
- **Scope:** `origin/main` at `cd443028` merged into pre-merge HEAD `d897a4eb`; the owning test and resource-event source were unchanged.
- **Original command:** the testing guide's macOS GNU-tool PATH with `/opt/homebrew/bin:/usr/bin` ahead of ambient shims, `mise run test:logged -- --name merge-final-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated workers. The workspace group waited 84.5 seconds for an earlier cancelled run's reservation before starting.
- **Failure:** Bun reported a 5000 ms timeout with observed duration 51229.17 ms, after backend initialization and resource mutations. The log also reported one dangling process killed.
- **Suite counts:** backend reported 9166 passed, 41 skipped and two failed across 9209 tests in 491 files (471.65 seconds). The other failure was the existing worktree-cache assertion in [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md). Other workspace packages, root/support, all bridges and protocol regeneration passed. Aggregate exit 1 in 608.1 seconds logged.
- **Isolated rerun:** the same PATH with `mise run test:logged -- --name merge-final-owner-resource-events -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/index-resource-events.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.4 seconds logged).
- **Evidence:** `orkestrator-test-run.cM59au/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.NdOLPH/merge-final-tests.log.gz`, both below the host temporary directory.
- **Hypothesis:** the unusually late timeout may reflect host scheduling or a stalled asynchronous operation; the cause is unconfirmed. No implementation, assertion, deadline or skip changed.
