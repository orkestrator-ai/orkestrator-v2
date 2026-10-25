# CLI project cascade browser case misses the fixture project

- **ID:** 0901
- **Status:** open
- **Date observed:** 2026-10-25
- **File:** `e2e/agent-testing/cli-ui.spec.ts:268`
- **Test:** `a CLI-initialized project and its cascade removal reach an open renderer`.
- **Revision:** `db35fb35f` plus the interaction review fixes, macOS arm64, Bun 1.4.4.
- **Original command:** `mise run test:logged -- --name browser-smoke -- mise run test:agent:browser:isolated --no-agent-credentials --agent-platforms codex`.
- **Failure:** the 120-second test deadline expired waiting for either `Expand project origin` or `Collapse project origin`, before the case initialized its project. The full browser run also had a new container-test setup error (subsequently corrected and qualified) and an unrelated annotation filename assertion that reproduces alone.
- **Owner rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=review-0001-docker-1025 mise run test:logged -- --name browser-cli-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/cli-ui.spec.ts --workers=1` passed both unchanged tests in 22.2 seconds including startup overhead.
- **Rerun fixture:** a fresh credential-free Codex profile with local and full-network container fixtures, rather than the original profile's local-only fixture. The cause is unknown; the richer fixture means this rerun does not establish that load caused the failure.
- **Evidence:** original `output/agent-testing/qa-browser-a6c7ec9c-d18/browser/`; private log `orkestrator-test-run.BHICIj/browser-smoke.log.gz` in the host temporary directory. Both disposable profiles were stopped and reset after testing.
- **Assessment:** intermittent fixture-project hydration in the broader run; no assertion, timeout or skip in the owning CLI browser file changed.
