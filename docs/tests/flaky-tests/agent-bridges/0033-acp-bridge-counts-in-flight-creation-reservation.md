# `ACP bridge > counts in-flight creation reservations against the session cap` (`bridges/acp-bridge/src/acp-server.test.ts`)

- **ID:** 0033
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside the bridges group, 3,091 tests across 115 files in 61.63 s.
- **Failure:** the case timed out at 5,059.00 ms. The bridges group reported two failures in that run; the other one, `reaps a session process when the creating HTTP client disconnects`, reproduces in isolation and is a separate, non-flaky problem (see Attribution).
- **Suite counts:** bridges group — 3,078 passed, 11 skipped, 2 failed; 9,913 `expect()` calls.
- **Isolated rerun:** `bun run test:logged -- --name rerun-acp -- bun test bridges/acp-bridge/src/acp-http.test.ts` → 5 passed, 1 failed, 37 `expect()` calls in 5.76 s. This case **passed**; only `reaps a session process when the creating HTTP client disconnects` failed, at 5,067.86 ms.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** `bun run test`
  timed out at the same `waitFor` after 5,053.98 ms; the bridges group
  reported 3,111 passed, 11 skipped, and 2 failed across 115 files. The
  isolated owner rerun,
  `bun test ./src/acp-http.test.ts ./src/acp-server.test.ts --only-failures`
  from `bridges/acp-bridge`, passed all 15 tests in 1.23 s.
- **Attribution:** observed while changing `apps/web` action-default resolution and `packages/protocol/src/action-defaults.ts`. Neither file is reachable from the ACP bridge, so the two share only host capacity. The host ran Bun 1.4.0 against the repo's pinned `bun@1.3.14`, and the same run produced six root-group failures that all reproduce in isolation — treat this observation as coming from a toolchain-mismatched host.
- **Hypothesis:** the case holds creation reservations open to prove they count against the session cap, so it is waiting on real bridge child processes under the generic 5-second budget. Under group-level contention those spawns miss the window, which is the same shape as the `announces overflow…` entry above in the same file. A recurrence should time the reservation's spawn-to-counted interval under load before widening the budget; a genuine cap regression would fail deterministically rather than at exactly the timeout.
- **Recurrence (Electron production logging, 2026-08-25):** `bun run test`
  timed out this case at 5,057.18 ms in its current owner,
  `bridges/acp-bridge/src/acp-server.test.ts`. The bridges group reported
  3,111 passed, 11 skipped, and 2 failed across 115 files in 60.65 s. The
  isolated rerun `bun test ./src/acp-server.test.ts` from
  `bridges/acp-bridge` passed all 9 tests in 0.884 s, with the target taking
  47.74 ms. The change in flight touched Electron logging, backend log-file
  management, shared retention validation, and the Settings UI; none is in
  the ACP bridge process path.
- **Bun 1.4 reproduction:** after the test moved to `acp-server.test.ts`, `bun test bridges/acp-bridge/src/acp-server.test.ts` reproduced the timeout in isolation at 5,044.75 ms (8 passed, 1 failed). The related disconnect case also reproduced in isolation in `acp-http.test.ts` at 5,043.46 ms (5 passed, 1 failed).
- **Root cause:** the repository preload replaces the Web APIs with Happy DOM's implementations. These two tests passed Happy DOM `AbortSignal` instances to `Bun.fetch`; Bun 1.4 validates the signal's native brand, rejects before sending either request, and leaves the lifecycle-file waits polling empty files until timeout.
- **Fix:** preserve Bun's native fetch and abort constructors before Happy DOM registration, then use that matched pair for the aborting ACP integration requests.
- **Verification:** `bun test bridges/acp-bridge/src/acp-http.test.ts` passed 6 tests with 40 assertions in 589 ms, and `bun test bridges/acp-bridge/src/acp-server.test.ts` passed 9 tests with 28 assertions in 853 ms under Bun 1.4.0. The subsequent complete `bun run test` passed all four concurrent groups in 87.3 s.
