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
