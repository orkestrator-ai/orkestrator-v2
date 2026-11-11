# Gateway maintenance navigation and diff tooltip fail late in the suite

- **ID:** 0484
- **Status:** open
- **Date observed:** 2026-10-18
- **Tests:** `host maintenance rehydrates task completion while Settings is closed (390px)` and `persisted diff baselines keep Files, the badge and diff tabs aligned after background changes and reload`.
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:2013`, `:2091`.
- **Original command:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-f53bd46a-35f`, one Playwright worker alongside component tests, the non-iOS aggregate and other worktrees.
- **Failures:** the narrow case could not find the drawer toggle at its 5000 ms deadline; the diff case could not find the current-baseline tooltip at its 5000 ms deadline. The host-picker case also failed (0224).
- **Suite disposition:** the isolated runner reached its 900000 ms test deadline after starting case 53 of 63, before a complete Playwright summary; exit 1 in 933.4 s including startup and cleanup.
- **Owning-file rerun:** fresh `dev:test --profile merge-paging-gateway-owner-1018 --fixture --no-agent-credentials --agent-platforms codex`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-paging-gateway-owner-1018 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-paging-gateway-owner-1018 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed the complete unchanged file (14 passed, six skipped, exit 0; 199.5 s logged).
- **Evidence:** `orkestrator-test-run.h4wMTk/merge-agent-browser.log.gz` below the host temporary directory; browser artifacts under `output/agent-testing/qa-browser-f53bd46a-35f/browser/` and passing statistics in `output/agent-testing/merge-paging-gateway-owner-1018/browser/results.json`.
- **Assessment:** confirmed intermittent observations; cumulative profile state and shared-host timing remain hypotheses. Both profiles were stopped and reset. No source, assertion, timeout or skip changed.

## Control MCP voice main merge — 2026-10-24

- `mise run test:agent:browser:isolated` on credential-free Codex fixture `qa-browser-a34c7ac6-c9f`, one worker, repeated the narrow maintenance case's missing drawer toggle at its five-second deadline (`browser-gateway.spec.ts:2428`). The same run also missed the moved environment's expected worktree path at the five-second deadline (`:2363`); its browser deadline later ended the run without a complete summary.
- The complete unchanged gateway owner ran separately in fresh credential-free Codex fixture `merge-gateway-0041-fc04c130` with `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-0041-fc04c130 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-0041-fc04c130 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`: 13 passed, ten skipped and only the narrow host-picker failure (case 0224), 346.0 s. Both maintenance viewports, the environment move and persisted diff passed.
- Evidence: `orkestrator-test-run.E1H1rN/merge-gateway-owner.log.gz` under the host temporary directory, with browser artifacts under `output/agent-testing/qa-browser-a34c7ac6-c9f/browser/` and `output/agent-testing/merge-gateway-0041-fc04c130/browser/`.
- The complete owner remains non-green because of 0224, so this observation does not newly classify the move failure as a flake. No source, assertion, timeout or skip changed for these observations.


## Runtime-state ownership main merge — 2026-10-24

The merge parents are feature `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and main `0014505caeed69395b3cc996dd541fcc6df12c23`. The renderer and both browser owning files match `origin/main`; no assertion, timeout or skip changed. `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` used credential-free Codex profile `qa-browser-a81b23d3-fdf`, one browser worker, alongside other validating worktrees. It reached its 900 s test deadline after starting case 56 of 83, with four recorded failures and no complete Playwright summary (923.2 s including lifecycle). Its runner stopped/reset the profile. Evidence: host temporary artifact `orkestrator-test-run.flXegA/merge-isolated-browser.log.gz`. The 390px maintenance case could not find the drawer toggle at its five-second deadline. The complete unchanged gateway owner ran on credential-free Codex/Docker fixture `merge-runtime-docker-1024`: `ORKESTRATOR_AGENT_TEST_PROFILE=merge-runtime-docker-1024 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-runtime-docker-1024-gateway mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`. It reported 13 passed, ten opt-in skips and one failed (316.6 s logged). The narrow host-picker case passed; the narrow maintenance case still failed while opening Updates. Evidence: `orkestrator-test-run.75cYgS/merge-gateway-owner.log.gz` under the host temporary directory and `output/agent-testing/merge-runtime-docker-1024-gateway/browser/`. The maintenance recurrence remains unresolved in the complete owner; the persisted-diff case passed.

## Renderer error ring review — 2026-11-11

Branch `renderer-error-ring-e3a48fce2746-r1` (to-dos 6300 and 6301), base
`498b68766`; `mise run flaky:recurrence -- 0484 --base 498b68766` reported
`open`. Neither `browser-gateway.spec.ts` nor the Settings dialog shell changed on
the branch (its only Settings change is wording in `RendererDebugSettings.tsx`).

- Review preparation's `mise run test:agent:browser:isolated` failed the 390px
  case at `browser-gateway.spec.ts:2894`: `locator.click: Timeout 1000ms exceeded`
  on **Open projects and environments**, because the open **Settings** dialog
  intercepted pointer events. The same run later reached the pipeline's command
  deadline (1529 s, about case 79 of 183).
- The case alone, on fresh credential-free `dev:test` profiles started with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`:
  `mise run test:logged -- --name agent-browser-maintenance -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts:2859`.
  - Profile `e3a4-ring-r1b` (`--agent-platforms codex`): 1280px passed, 390px
    failed the same way, from the first `openUpdates()` call (`:2914`). The
    failure screenshot shows **Settings** open on General.
  - Profile `e3a4-ring-r1` (`--agent-platforms claude`): both widths failed, but
    the "Claude Code Is Not Logged In" alert covered the page, which is how a
    credential-free Claude profile starts. That run is no evidence either way.
- **Hypothesis (not confirmed):** the narrow `toPass` body is not idempotent. Its
  first attempt clicks **Global settings**, the first Settings open (a lazily
  loaded chunk on a dev server) is not visible within the 1 s inner check, and
  every retry then tries to open the drawer underneath the open dialog. A body
  that skips the drawer when **Settings** is already visible would test the same
  path.

Both profiles were stopped and reset. No source, assertion, timeout or skip
changed.
