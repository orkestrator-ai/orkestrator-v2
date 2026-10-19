# Coordinator fetch-every-remote case hits the five-second timeout under load

- **ID:** 0461
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on
  branch `qualify-annotation-live-implement-0330a0bacc01` (`50c26708`; the
  coordinator is not changed by this branch)
- **Worker configuration:** the four default `mise run test` groups
  concurrently on a heavily loaded macOS host; the workspace group took
  691.5 s. Flake 0165 timed out in the same file in the same run.
- **Failure:** bun's five-second default timeout at 5198.09 ms, with no
  assertion message. The case runs real Git fetches against several remotes
  and a submodule.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
- **Isolated rerun:**
  `mise run test:logged -- --name iso-coordinator -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures`
  passed (28.4 s for the file; 52 passed in a plain `bun test` run too).

## Current assessment

The same shape as 0165: several real Git operations inside one five-second
budget. Keep open until a recurrence shows whether it needs an explicit
timeout or a cheaper fixture.


## Queued-steer recovery validation recurrence — 2026-10-19

- **Revision:** `1ad88982`, branch `queued-prompt-steering-3970ea85ceea-r1`.
- **Original command:** `mise run test:logged -- --name queued-steer-handoff-full -- mise run test`, Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside another worktree's validation.
- **Failure:** the indexed test exceeded its 5000 ms deadline at 5227.61 ms. Coordinator timeouts were followed by two between-test errors from late Git work after fixture cleanup.
- **Suite result:** backend reported 9105 passed, 41 skipped, three failed and two between-test errors across 9149 tests in 486 files (339.43 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed. Aggregate exit 1 after 498.4 seconds, including the workspace resource wait.
- **Isolated rerun:** `mise run test:logged -- --name coordinator-timeout-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0 (10.3 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.JzdYLc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer run `orkestrator-test-run.MYt5Tx/queued-steer-handoff-full.log.gz` under the same temporary root.
- **Assessment:** owning-file passes confirm recurrence of the existing flakes. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip was changed; the queued-steer regression tests passed.
