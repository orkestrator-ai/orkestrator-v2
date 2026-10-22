# OpenCode live idle-observation turn stalled in the provider's model stream

- **ID:** 0670
- **Status:** environmental
- **Date observed:** 2026-10-21
- **Test:** `live idle observation > OpenCode: idle observation settles every live case`, case `missed-final`
- **File:** `e2e/agent-testing/idle-observation-live.spec.ts`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-faa8 ORKESTRATOR_AGENT_TEST_RUN_ID=idleqa-final-1 ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_MODELS=opencode=opencode-go/deepseek-v4.1-flash bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/idle-observation-live.spec.ts --workers=4 --fully-parallel`
- **Worker configuration:** four Playwright workers (Claude, Codex, Cursor and OpenCode in parallel) against one manual `dev:test --fixture` profile, macOS 27.0 on Apple Silicon, OpenCode 1.19.0 with an `opencode` API-key provider seeded into the profile.
- **Failure:** the reply-only turn dispatched through `dispatch_native_agent_intent` stayed `running` with no assistant row for the 240 s turn timeout ("OpenCode never settled: phase running, reply false"). The other seven cases on the same session passed after the case stopped the turn.
- **Evidence:** OpenCode's own log (`<profile data>/agent-credentials/xdg-data/opencode/log/opencode.log`) shows the turn's `stream providerID=opencode modelID=big-pickle` starting at 01:17:38Z and nothing until the spec's `cancel` at 01:21:39Z (`error=Aborted`). OpenCode was still streaming the model request, so `running` was the truth. The backend log had no error for the environment.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=opencode ORKESTRATOR_AGENT_TEST_IDLE_CASES=missed-final ... --repeat-each=3` passed 3 of 3 (3.9 min); the case had also passed in two earlier sequential runs and one earlier parallel run.
- **Assessment:** environmental: the hosted model returned nothing for four minutes. Not an observation defect, since the view and the backend both reported the provider's real state. The spec now records the session's actual model and sends the dispatch in build mode, which the OpenCode case had been sending in plan mode (`agent=plan` in the same log).
