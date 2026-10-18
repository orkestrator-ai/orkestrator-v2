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
