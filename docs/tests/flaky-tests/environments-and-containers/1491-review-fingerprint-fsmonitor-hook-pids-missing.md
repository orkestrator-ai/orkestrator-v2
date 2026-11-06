# Fingerprint timeout reaps a blocking fsmonitor hook, hook pids missing (apps/backend/src/core/review-worktree-fingerprint.test.ts)

- **ID:** 1491
- **Status:** resolved
- **Test:** `timeout reaps a blocking fsmonitor hook and descendants before fallback (node)`
- **Date observed:** 2026-10-31
- **Original command:** `mise run test`
- **Worker configuration:** backend workspace `bun test` at 4x parallel, on mbp3 with other workers running at the same time
- **Failure:** `ENOENT` opening `.git/hook-pids` in the test's temporary repository (duration: 2.35 s)
- **Suite counts:** backend 11778 total, 11673 passed, 103 skipped, 2 failed
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/review-worktree-fingerprint.test.ts` from `apps/backend`, three times → passed each time (15 pass, 0 fail)
- **Hypothesis:** the test shortens the status timeout to 1500 ms and then reads the pid file the blocking hook writes. The assertions before that read passed, so the fingerprint and its fallback ran, but no pid file existed: the hook appears not to have written it before the timeout fired. Not reproduced under controlled load. The same test passed in the run before it. The change on the branch (retiring the legacy close fallback) does not touch this code.

### Resolution — 2026-11-06

- **Status reason:** stale. The test no longer exists. `b4a64b73e` (#1883,
  "bound and serialize review worktree probes", 2026-11-06) changed the
  review worktree fingerprint so that it never runs the worktree's fsmonitor
  hook: its Git calls pass `--no-optional-locks -c core.fsmonitor=false`.
  The same commit replaced `timeout reaps a blocking fsmonitor hook and
  descendants before fallback` with `never runs the worktree's fsmonitor hook
  or takes optional locks`. That removed the blocking hook, the 1.5 s status
  timeout and the `.git/hook-pids` read that raced it. No version of the test
  file after `22c9612a9` mentions `hook-pids`.
- **Root cause (historical, unproven):** the hook-pid file was read after a
  1.5 s timeout that could fire before the blocking hook had started and
  written its PID under load. The path no longer exists to test.
- **Change in this pass:** none.
- **Verification:** `mise run test:logged -- --name env-fingerprint -- bun
  --cwd=apps/backend test ./src/core/review-worktree-fingerprint.test.ts
  --parallel=1 --rerun-each=5`: PASS in 65.2 s.
