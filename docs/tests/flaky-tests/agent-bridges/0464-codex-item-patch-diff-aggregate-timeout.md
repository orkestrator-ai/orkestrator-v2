# Codex patch diff aggregate timeout

- **ID:** 0464
- **Status:** resolved
- **Date observed:** 2026-10-18
- **File:** `bridges/codex-bridge/src/item-to-parts.test.ts`
- **Test:** `itemToParts > keeps apply_patch diffs scoped to each file_change invocation`
- **Original command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, four aggregate groups with workspace/root/bridges/protocol reservations of 4/1/2/1; bridge tasks used one worker each. Codex group: 2227 passed, 4 failed across 82 files.
- **Evidence:** `orkestrator-test-run.LitzDV/bridges.log.gz` (under the platform temporary directory).
- **Failure:** The case exceeded its 30-second deadline (30000.83 ms).
- **Isolated reruns:** The first owning-file run failed before tests because port 65456 was in use. `PORT=0 mise run test:logged -- --name merge-item-to-parts-free-port -- bun test --cwd bridges/codex-bridge ./src/item-to-parts.test.ts --parallel=1 --only-failures` then passed unchanged, exit 0, 1.4 s.
- **Assessment:** Aggregate scheduling or child startup latency is unconfirmed. The separate port collision was avoided with an ephemeral port; no source, assertion or timeout changed.

## Resolution (2026-11-10)

- **Status:** resolved; the test and the code path it timed were replaced.
- **Root cause:** not established. The deleted test built a real Git
  repository with synchronous `git init`, `config`, `add` and `commit`
  subprocesses, then made `itemToParts` diff each `file_change` against the
  worktree and per-invocation baselines. On the loaded aggregate host that
  run of Git subprocesses was the likely cost behind the 30 s deadline.
- **Fix:** already on `main`. `d9bc8b840` (`feat: add agent change
  tracking`, #1107, 2026-10-20) builds file-change rows from app-server's own
  per-change payload and never reads the worktree. It removed this test, the
  baseline map it exercised and the worktree-diff path. The remaining
  `item-to-parts.test.ts` case that still creates a repository, `renders an
  update from its supplied hunks, never from the worktree`, makes no Git call
  from `itemToParts`. The last observation (2026-10-18) predates that commit.
  No change in this sweep.
- **Reproduced:** no — the test and the worktree-diff path no longer exist.
- **Stress:** `mise run test:logged -- --name codex-item-to-parts-0464 -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/item-to-parts.test.ts --parallel=1 --rerun-each=20`
  passed (exit 0, 10.3 s) on a host at load average about 35. It checks the
  current owner, not the deleted test.
