# Long transcript fixture exceeds its aggregate deadline

- **ID:** 0627
- **Status:** open
- **Test:** `long transcript fixture > bounded concurrency and queues; caches converge within bounds over 20 scroll/expand cycles`.
- **Owner:** `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx:309`.
- **Observation date:** 2026-10-21.
- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`.
- **Workers:** workspace/root/bridge/protocol groups reserved 4/1/2/1 slots;
  web used two isolated Bun workers. Other worktree validations and browser
  checks were active on the host.
- **Web aggregate counts:** 8,550 passed, 10 skipped, two failed and one error
  across 8,562 tests in 517 files (506.60 s).
- **Evidence:** `orkestrator-test-run.RzbPLB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.
- **Failure:** Bun reported `this test timed out after 120000ms` at 120,689.26 ms.
- **Owning-file rerun:** `mise run test:logged -- --name long-transcript-rerun -- bun --cwd=apps/web test ./src/components/chat/rich-transcript.long-fixture.test.tsx --parallel=1 --only-failures`
  passed unchanged (three tests, exit 0, 89.7 s logged).
- **Assessment:** confirmed intermittent deadline failure. Host scheduling or
  fixture cost under load may contribute; the rerun does not establish a cause.
  No assertion, timeout or skip changed.

## Two-column report main merge — 2026-10-21

The long fixture exceeded 120 seconds (120,789.83 ms) in the aggregate; the complete unchanged owner passed in 23.5 seconds (`merge-long-transcript-owner`). See [0629](../aggregate-validation-runs/0629-two-column-main-merge-validation.md) for commands, worker configuration, counts and evidence. No source, assertion, timeout or skip changed.


## Machines settings main merge — 2026-10-22

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-tests -- mise run test`, initially merging `c17f1c8d5` into `814afe472`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; web used two isolated workers alongside browser and Docker validation.
- **Failure:** the 20-cycle case exceeded 120000 ms (120236.07 ms). The overall run was interrupted to include newly published main commits, so its workspace coverage is incomplete and no final workspace counts are claimed.
- **Complete unchanged owner on the refreshed merge (`7e051d955`):** `mise run test:logged -- --name merge-long-owner -- bun test --cwd apps/web ./src/components/chat/rich-transcript.long-fixture.test.tsx --parallel=1 --only-failures` passed all three cases, exit 0 in 19.9 s.
- **Evidence:** `orkestrator-test-run.x69ru0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.zXH9t0/merge-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent deadline recurrence; contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## MCP overlay review validation — 2026-10-23

`mise run test:logged -- --name repository-tests -- mise run test` exceeded this owner's existing 120-second deadline at 120475.64 ms, followed by a missing `Details 58` assertion from the timed-out work. Web reported 8836 passed, ten skipped, one failed and one error. The complete unchanged three-case owner passed with `mise run test:logged -- --name transcript-owner -- bun test --cwd apps/web ./src/components/chat/rich-transcript.long-fixture.test.tsx --parallel=1 --only-failures` (exit 0, 9.0 s). No assertion, timeout or skip changed. Evidence: host temporary directory `orkestrator-test-run.ZHucAO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.MYw34M/repository-tests.log.gz`. Contention remains a hypothesis; the aggregate remains failed.
