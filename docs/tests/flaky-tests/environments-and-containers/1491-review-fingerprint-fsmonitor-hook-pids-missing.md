# Fingerprint timeout reaps a blocking fsmonitor hook, hook pids missing (apps/backend/src/core/review-worktree-fingerprint.test.ts)

- **ID:** 1491
- **Status:** open
- **Test:** `timeout reaps a blocking fsmonitor hook and descendants before fallback (node)`
- **Date observed:** 2026-10-31
- **Original command:** `mise run test`
- **Worker configuration:** backend workspace `bun test` at 4x parallel, on mbp3 with other workers running at the same time
- **Failure:** `ENOENT` opening `.git/hook-pids` in the test's temporary repository (duration: 2.35 s)
- **Suite counts:** backend 11778 total, 11673 passed, 103 skipped, 2 failed
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/review-worktree-fingerprint.test.ts` from `apps/backend`, three times → passed each time (15 pass, 0 fail)
- **Hypothesis:** the test shortens the status timeout to 1500 ms and then reads the pid file the blocking hook writes. The assertions before that read passed, so the fingerprint and its fallback ran, but no pid file existed: the hook appears not to have written it before the timeout fired. Not reproduced under controlled load. The same test passed in the run before it. The change on the branch (retiring the legacy close fallback) does not touch this code.
