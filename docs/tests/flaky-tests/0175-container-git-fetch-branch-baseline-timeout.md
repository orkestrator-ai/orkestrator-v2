# container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches (apps/backend/src/core/container-git-fetch-git.test.ts)

- **ID:** 0175
- **Status:** open
- **Date observed:** 2026-09-28
- **Original command:** `mise run test:logged -- --name backend-workspace -- bun run --cwd apps/backend test:workspace`
- **Worker configuration:** the backend package's own `test:workspace` script, run straight after two full `mise run test` passes on the same host.
- **Failure:** the test exceeded Bun's default 5-second timeout (reported at 5205 ms), followed by `killed 1 dangling process`.
- **Suite counts:** 5278 total, 5262 passed, 1 failed, 15 skipped (305 files, 153.88 s)
- **Isolated rerun:** `mise run test:logged -- --name git-fetch-alone -- bun test --cwd apps/backend src/core/container-git-fetch-git.test.ts src/core/plan-usage.test.ts` → passed (4.8 s for both files)
- **Hypothesis:** the case runs real `git` processes against a local remote. Under aggregate load its total wall time crosses the 5-second default, and the dangling process was the in-flight `git` child the timeout abandoned. Host load average was about 8 shortly after the failure. It passed in the preceding full `mise run test` on the same change. The change in progress (multi-account support) does not touch the container git scripts or this test.

## Cold restart review qualification — 2026-10-21

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, alongside isolated live cold-restart qualification; workspace/root/bridges/protocol reserved 4/1/2/1 slots.
- **Failure:** `a branch baseline follows origin/<ref> only when the policy fetches` exceeded the default 5000 ms deadline (5174.64 ms). Backend reported 9739 passed, 67 skipped, three failed and one between-test error across 9809 tests in 551 files (630.83 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name container-git-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 5.5 seconds logged).
- **Evidence:** `orkestrator-test-run.K1HiOG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent load is an unconfirmed explanation. No implementation, assertion, timeout or skip changed.

## 2026-10-21 recurrence during node profile notification validation

- **Snapshot:** `b2c385c1e` plus the node profile notification fix and its integration tests; the Git scripts and this owning test file were unchanged.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** four aggregate groups; workspace held four worker slots, with at most two package tasks and two Bun workers per package. Root held one slot, bridges two and the protocol check one.
- **Failure:** the same branch-baseline case timed out after 5000 ms (reported at 5100.95 ms), with `killed 1 dangling process`. An unhandled `script exited 143` from the case's `shell()` helper followed the timeout.
- **Suite counts:** backend: 9973 tests across 570 files, 9904 passed, 68 skipped, one failed and one error (467.27 s). The other workspace packages, root/support, bridges and protocol check passed. The full logged command exited 1 after 506.7 s.
- **Isolated rerun:** `mise run test:logged -- --name container-fetch-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` → all six tests passed unchanged (3.7 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ozsKgo/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** consistent with the existing aggregate-load timeout hypothesis; no timeout or assertion was changed. The full aggregate remains a failed validation result, with this isolated pass confirming the recurrence is intermittent.
