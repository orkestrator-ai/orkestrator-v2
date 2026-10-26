# Docker rebuild dialog after reload

- **ID:** 0953
- **Status:** open
- **Date observed:** 2026-10-25, during container security validation.
- **Renumbered:** filed as 0887, a number [aggregate case 0887](../aggregate-validation-runs/0887-live-provider-review-validation.md) already held, and without the ID and Status lines the register test requires; renumbered to 0953 on 2026-10-26 (todo 0166 branch). The observation below is unchanged.

`Docker fixture rebuild keeps running while another environment is open and rehydrates`
failed in `mise run test:agent:docker` because `Before a rebuild` was not visible
within 15 seconds after reloading and reopening the container section.
The unchanged owning specification passed alone in 31.3 seconds against the
same disposable `security-review` profile:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=security-review ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name docker-rebuild-isolated -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/container-rebuild-cycle.spec.ts
```

The aggregate had 11 passing, 2 failing and 3 skipped scenarios. Its other
failure was a deterministic annotation filename expectation, unrelated to this
intermittent dialog observation. No timeout or assertion was relaxed.

Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.sCziks/summary.json`.
Passing isolated output was removed by the logged runner.
