# `AcpChatTab > keeps a rejected initial prompt available for a remount retry` (`apps/web/src/components/acp/AcpChatTab.test.tsx`)

- **ID:** 0081
- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun run --cwd apps/web test` (`bun test src --parallel`)
- **Worker configuration:** Bun reported `18x PARALLEL` across the web package.
- **Failure:** `expect(received).toHaveBeenCalledTimes(expected)` at `AcpChatTab.test.tsx:190` -- `Expected number of calls: 2`, `Received number of calls: 1` (durations 7.45-58.24 ms).
- **Suite counts:** 5,507 total, 5,505 passed, 1 skipped, 1 failed across 225 files.
- **Isolated rerun:** `bun test src/components/acp/AcpChatTab.test.tsx` from `apps/web` -> 7 passed, 0 failed, repeated 10 times with zero failures. The aggregate suite reproduced the failure in roughly two runs out of five.
- **Root cause:** The test dispatches a failing initial prompt, unmounts, remounts, and then waits with `toHaveBeenLastCalledWith`. The first mount had already recorded a call with those exact arguments, so the `waitFor` was satisfied immediately and nothing actually waited for the remount to connect and dispatch. The following `toHaveBeenCalledTimes(2)` then raced the second mount's asynchronous bridge handshake, and lost whenever aggregate load delayed it.
- **Fix:** Wait on the call *count* (`waitFor(() => expect(...).toHaveBeenCalledTimes(2))`) and assert the arguments afterwards, so the wait is tied to the event the test is actually about.
- **Verification:** `bun run --cwd apps/web test` -> 6 consecutive runs, 5,506 passed, 0 failed each. `bun test src/components/acp/AcpChatTab.test.tsx` from `apps/web` -> 10 consecutive runs, 0 failures.
