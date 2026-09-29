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
