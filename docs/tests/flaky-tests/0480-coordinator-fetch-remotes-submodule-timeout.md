# Coordinator fetch across remotes times out under aggregate load

- **ID:** 0480
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`
  on branch `qualify-transcript-paging-live-mr-c2fa28c0ecdd` (live transcript
  paging qualification; the change touches only the web transcript views and
  an opt-in e2e spec, not the coordinator service).
- **Worker configuration:** the workspace group concurrent with the root,
  bridges and codex-protocol groups on a shared macOS arm64 host running
  several other agents' live test profiles.
- **Failure:** timed out at 5262.12 ms (bun's five-second default). No
  assertion message. The backend reported 9,016 passed, 41 skipped and 2
  failed across 480 files (414.4 s); the other failure was flake
  [0180](0180-worktree-tracked-edit-cache-hit.md). Every other workspace
  package, root/support, bridges and protocol passed.
- **Isolated rerun:**
  `mise run test:logged -- --name coordinator-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed, exit 0 (22.2 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9ChzHs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Current assessment

A timeout under aggregate load, the same shape as
[0165](0165-coordinator-bound-discard-timeout.md) in the same file: the case
runs real Git fetches against several remotes plus a submodule inside one
five-second budget. Keep open until a recurrence shows whether it needs an
explicit timeout or a cheaper fixture. No coordinator implementation,
assertion, timeout or skip changed.

## Transcript-paging review fixes — 2026-10-18

`mise run test:logged -- --name full-tests -- mise run test` repeated both
coordinator timeouts (bound discard: 5169.70 ms; remote fetch: 5197.15 ms).
The backend reported 9,040 passed and two failed; every other workspace package,
the root/support group, bridges, and protocol check passed. The complete run
took 445.2 seconds alongside browser and live-provider validation.

The unchanged owning file then passed, exit 0, in 11.7 seconds:

```bash
mise run test:logged -- --name coordinator-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.g5ONdt/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No coordinator code, test, timeout, or assertion changed.

## Further main merge at f51c7252 — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `f51c7252` into `17c19221`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated Bun workers alongside targeted browser and CLI validation on the shared host.
- **Failure:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation` exceeded its 5000 ms deadline at 5149.44 ms. The coordinator timeouts also produced late fixture errors after their deadlines.
- **Suite counts:** backend 9088 passed, 41 skipped and four failed across 9133 tests in 485 files (385.41 s); every other workspace package, root/support, bridges and protocol passed. Aggregate exited 1 after 445.1 s.
- **Owning-file rerun:** after the aggregate, the same GNU-tool PATH with `mise run test:logged -- --name refresh-main-owner-coordinator -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 11.2 s. The three owning files ran sequentially.
- **Evidence:** `orkestrator-test-run.AP1Ws9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.TVK3dv/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.
