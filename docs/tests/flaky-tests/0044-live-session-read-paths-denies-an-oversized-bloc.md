# `live session read paths > denies an oversized blocking hook without broadcasting truncated approval data` (`tests/unit/electron/tmux-session.test.ts:1166`)

- **ID:** 0044
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was in the root/agent-support group.
- **Failure:** `expect(existsSync(pending)).toBe(false)` received `true` at `tmux-session.test.ts:1166` (duration: 606.40 ms). The oversized approval was correctly denied — the emitted hook response carried `permissionDecision: "deny"` — but the pending approval file had not yet been removed when the assertion ran.
- **Suite counts:** 3,741 passed, 1 skipped, 1 failed; 3,743 tests across 181 files in 95.69 s.
- **Isolated rerun:** `bun test tests/unit/electron/tmux-session.test.ts` → 69 passed, 0 failed, in 25.36 s.
- **Follow-up:** Five further complete aggregate runs (`bun run test`) passed, at 94.5 s, 86.6 s, and three more; the failure has not recurred.
- **Hypothesis:** The assertion checks the pending-approval file synchronously right after the deny response is observed, but the file removal is a separate filesystem write on the tmux hook path. Under aggregate contention the removal can land after the response. A recurrence should poll for the file's absence with a bounded diagnostic rather than asserting it in the same tick as the response, and should first confirm that the removal is genuinely ordered after the response rather than racing it in production.
