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
