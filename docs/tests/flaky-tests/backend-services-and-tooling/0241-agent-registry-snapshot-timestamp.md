# Agent registry snapshots cross a millisecond boundary

- **ID:** 0241
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `AgentRegistry > lists every agent tab and coordinator with live state and counts`
- **Owning file:** `apps/backend/src/core/agent-registry.test.ts:117`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Consecutive snapshots differed only in `generatedAt`, by one millisecond (11.26 ms).
- **Suite counts:** Backend: 7,983 passed, 39 skipped, 2 failed across 434 files (299.03 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-registry-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-registry.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (0.1 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Hypothesis:** The test compares independently generated snapshots with exact equality, including the wall-clock generation timestamp. A clock boundary between the calls explains the recorded difference.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Resolution (2026-11-10)

- **Root cause:** the test compared the `get_agent_registry` command's
  snapshot with a second `registry.snapshot()` taken just after it using exact
  equality, and each snapshot stamps `generatedAt` with `new Date()`
  (`apps/backend/src/core/agent-registry.ts`). Two calls on either side of a
  millisecond boundary differ only in that stamp, which is the recorded diff.
  Nothing in the product raced.
- **Fix:** already on `main` before this sweep: `cefcaf691` (#999, merged
  2026-10-15) compares the two snapshots with `generatedAt:
  expect.any(String)` and keeps every other field exact. The observing merge
  base `d087e44f` predates that commit (`git merge-base --is-ancestor
  cefcaf691 d087e44f` is false), so the recorded failure ran the old
  assertion. No further change.
- **Reproduced:** yes — a scratch copy of the owner with the stamp matcher
  removed (`anyStamp = {}`) failed 107 of 300 runs of this test with the
  `generatedAt` diff (`bun test --preload ../../tests/setup-node.ts
  ./src/core/agent-registry-repro0241.test.ts -t "lists every agent tab"
  --rerun-each=300` from `apps/backend`, copy deleted afterwards). The
  unchanged owner passes the same condition.
- **Stress:** `mise run test:logged -- --name stress-agent-registry -- bun
  scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./src/core/agent-registry.test.ts --rerun-each=50`
  passed (macOS, unpinned burners, host load ~35).
