# CLI project cascade browser case misses the fixture project

- **ID:** 0901
- **Status:** resolved
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
- **Root cause, beelink (Linux), 2026-11-03,** on the branch for to-do [2181](../../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md). `login()` returned at `domcontentloaded` and the case navigated again at once, while the login page's module graph was still loading. The gateway then answered the new document's `/@vite/client` and `/src/main.tsx` with 502, and the page stayed blank with no retry, so `Expand project origin` never appeared. Two traces show exactly those two 502s: this case in `mise run test:agent:browser:isolated`, and `CLI changes reach an open renderer and survive a reload` (the same `login()`) in one of three repeats alone.
- **Fix and verification:** `login()` in `e2e/agent-testing/cli-ui.spec.ts` waits for `load`, which module scripts delay, and no assertion changed. With it, both cases passed five of five with `--repeat-each=5 --workers=1` (10 passed, 0 failed, about 39 s). Why the gateway answers 502 in that race was not investigated; a spec that navigates twice this way could still hit it.
