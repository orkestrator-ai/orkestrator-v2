# Live paused interactions: Codex cases incomplete in a combined run

- **ID:** 9898
- **Status:** open
- **Date observed:** 2026-11-06
- **Base commit:** `110103980` (origin/main) under branch `agent-updates-83314c263ef1-r1`, Codex CLI 0.167.0, Claude CLI 2.1.319, OpenCode 1.19.5.
- **Test:** `a paused question and approval wait past ten minutes on every provider, then resume`.
- **File:** `e2e/agent-testing/paused-interactions-live.spec.ts`.
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-1031-upgrade ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,codex,opencode ORKESTRATOR_AGENT_TEST_PAUSE_WAIT_MS=1000 ORKESTRATOR_AGENT_TEST_PAUSE_MODELS=codex=gpt-6.1-sol,opencode=opencode-go/deepseek-v4.1-flash mise run test:logged -- --name qa-1031-pause -- bunx playwright test --config e2e/agent-testing/playwright.paused-interactions.config.ts --workers=1`, against a signed-in `dev:test` profile.
- **Workers:** one Playwright worker; six live sessions (Claude, Codex, OpenCode; one question and one approval each) in one test.
- **Failure:** all six requests were raised and both Claude cards paused; pausing the Codex question card then failed: after `Resume countdown` the backend's `hold.heldAt` stayed set past the 5 s `expect.poll` (`Timeout 5000ms exceeded while waiting on the predicate`). Suite: 1 failed, 2 passed (51.6 s). A Codex-only rerun (`ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex`) then completed the question case (raised, paused, pending after a minute, answered, finished with the answer) but left the approval `incomplete` after it was answered (6.0 min), as 1020 recorded on 2026-10-30.
- **Isolated reruns:** `ORKESTRATOR_AGENT_TEST_PAUSE_CASES=codex-approval` alone passed (43.4 s); `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,opencode` passed all four cases (41.1 s).
- **Hypothesis:** not established. Both symptoms involve Codex cards when another Codex case shares the run: the hold clearing after a resume and the approval's continuation after the answer. Neither touches code the 2026-11-06 upgrade changed (the hold path is unchanged; the upgrade only added the optional `humanRequired` and `toolHints` fields). Reproduce with two Codex cases in one run before fixing.
- **Related:** [1031](../../../todo/agent-engines/1031-provider-upgrade-2026-11-06.md) task 9; 1020 (retired 2026-11-13) "Review repair and signed-in evidence", `git show 17d28238c:docs/todo/agent-engines/1020-provider-upgrade-2026-10-30.md`.
