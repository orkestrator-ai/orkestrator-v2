# Backend resource event aggregate timeout

- **ID:** 0503
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** the default five-second Bun test/hook budget was spent while the process was starved of CPU on a loaded host; the body is milliseconds to seconds of work when the host is idle and waits on no signal that could be made explicit.
- **Fix:** `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`) now sets the default per-test and per-hook budget to 60 s, a hang watchdog that a slow host does not trip. `apps/backend/src/core/index-resource-events.test.ts` has no smaller explicit budget (no `setDefaultTimeout`, third-argument or hook timeout, and no wall-clock deadline of its own), so the new default applies to it. No assertion, skip or production code changed.
- **Reproduced:** no. Not reproduced here (the host load average was 100 to 180 from other workers' runs, and a contention run of the owner did not finish); the class is established from the recorded timeouts at the 5 s default with the owner passing alone, not from a local failure.
- **Stress:** none specific to this case; the owner passes unchanged in this tree.
