# Long transcript fixture exceeds its aggregate deadline

- **ID:** 0625.
- **Status:** open.
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
