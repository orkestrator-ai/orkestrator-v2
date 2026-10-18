# Claude live design cycle rejected by the account rate limit

- **ID:** 0450
- **Status:** environmental
- **Date observed:** 2026-10-18
- **Test:** `live design-tool cycle (claude) > Claude creates, refines and saves a design; Ask agent, approval and handoff survive environment switches`
- **File:** `e2e/agent-testing/design-live.spec.ts`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-live-c2 ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1 ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS=claude ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS=360000 bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-live.spec.ts --workers=1`
- **Worker configuration:** one Playwright worker against a manual `dev:test --fixture` profile using the host's Claude login, while many other agent sessions on the same account ran concurrently (a coordinator batch).
- **Failure:** the launch turn ended `error` with "Claude ended the turn on an API error." The CLI rollout recorded `API Error: Request rejected (429) · This request would exceed your account's rate limit.` Six consecutive runs between about 17:35 and 18:08 BST failed this way, on the default model and with `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS=claude=claude-haiku-4-5`.
- **Isolated rerun:** not possible while the account stayed limited. Earlier the same day the launch cycle passed once in the spec and four times in launch-only probes on the same profile.
- **Assessment:** environmental, not a product or test defect: the account had no request headroom. The spec reports the turn error with a content-free transcript outline, so a 429 is recognisable without reading the rollout. Rerun on an account with headroom; the remaining Claude steps are tracked in [design-canvas-qualification.md](../../todo/design-canvas-qualification.md).
