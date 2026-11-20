# NativeAgentService healthy-commit test timed out under aggregate load

Current path for the relocated file: `apps/backend/src/core/native-agent/service-base.test.ts`.

- **ID:** 0950
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `NativeAgentService > commits a healthy environment while another environment's provider fails`
- **File:** `apps/backend/src/core/native-agent-service-base.test.ts:2267`
- **Change under test:** todo 0145 (Claude Linux sandbox probe), which touches neither this owner nor its subject.
- **Original command:** `mise run test` on macOS, Bun 1.4.4, branch `todo-0145-claude-linux-sandbox-39a58b878dd6` (head `4c54d788e`), with other worktrees validating on the host (load average about 21).
- **Aggregate result:** timed out after 5,000 ms (5093.73 ms reported) in the backend workspace group; two other backend tests in unrelated files timed out the same way in the same run (0951, 0621).
- **Unchanged owner rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-base.test.ts --parallel=1` passed (67 pass, 0 fail).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pHWGe9` (the run's failure artifacts).
- **Hypothesis:** host load stretched the test past Bun's five-second default. Unproven; no implementation, assertion, timeout or skip changed.

### Investigation — 2026-11-06

- The case takes about 90 ms (30 reruns in 2.7 s, including setup). A 5 s timeout is a 50x stretch, not ordinary contention, and two unrelated backend files timed out the same way in the same run (0951, 0621). A host-wide stall, such as a blocked event loop or disk, fits better than anything in this test. Not reproducible; status stays open.

## Resolution (2026-11-15)

- **Root cause:** The healthy-commit case exceeded Bun's 5 s default (5,093.73 ms) at load 21; it has no inner deadline.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
