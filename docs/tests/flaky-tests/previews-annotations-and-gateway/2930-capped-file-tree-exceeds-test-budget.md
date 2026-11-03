# Capped file-tree browser journey runs at its 120 s test budget

- **ID:** 2930
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `capped file tree loads subtrees, retries failures and refreshes across inactive views and reload`
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:751`
- **Revision:** environment-terminology branch `rename-environment-kinds-fbee095fc40a-r1` (`9940fb04a`, then `619c7476d`), and detached `origin/main` at `d7cdfaa8b`. The branch changes no file-tree, gateway or e2e code.
- **Original command:** `mise run test:agent:browser:isolated` (review preparation), arktech-mini (macOS), worktree on the external `/Volumes/Lexar` volume.
- **Failure:** `Test timeout of 120000ms exceeded`, at a different step each time: `cap-source.ts` visibility at line 900 (branch, preparation); expanding `build` at line 838 via line 892 (main, isolated suite).
- **Reruns, the case alone** (`ORKESTRATOR_AGENT_TEST_PROFILE=<profile> mise run test:logged -- --name <name> -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts -g "capped file tree"`, three times each against fresh `--fixture --no-agent-credentials` profiles):
  - Branch (`ek-filetree-br`): passed in 123.3 s; timed out in 127.2 s (line 898, `inactive.o`); timed out in 126.4 s (line 895, the cap notice).
  - `origin/main` (`ek-filetree-main`): timed out in 127.8 s (line 897); failed in 121.2 s (line 838, `build` not visible); passed in 119.3 s.
- **Assessment:** intermittent on both branch and target branch by the registry's rule, with the same one-in-three pass rate. Passing runs take 119–123 s against the config's 120 s `timeout`, so the journey (5,100 files written into the worktree, two reloads, a viewport change) consumes the whole budget on this host, and whichever step is running when the budget expires reports the failure. No implementation, assertion, timeout or skip changed.
- **Evidence:** per-run `results.json` copies under `output/agent-testing/env-kinds-review-fix/filetree/` in the terminology worktree (git-ignored).
