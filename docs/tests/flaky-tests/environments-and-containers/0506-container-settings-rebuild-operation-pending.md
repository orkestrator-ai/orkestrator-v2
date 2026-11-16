# Container settings rebuild preview meets a preceding operation

- **ID:** 0506
- **Status:** open
- **Date observed:** 2026-10-20
- **Test:** `Docker fixture container settings show backend state and rehydrate (desktop)`
- **Owner:** `e2e/agent-testing/container-settings.spec.ts:79`

## Main merge validation

- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-docker-0f4cfe ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-docker-0f4cfe mise run test:logged -- --name merge-docker -- mise run test:agent:docker`.
- **Configuration:** one Playwright worker; isolated local/container fixture; workspace-specific development image rebuilt from the merged tree. The non-iOS aggregate and browser/Electron checks ran alongside this suite.
- **Failure:** the desktop case did not find `Rebuild container and keep its files?` within 30 seconds at line 113. The saved accessibility snapshot instead showed `Rebuild unavailable` and `Another container operation is running for this environment. Nothing was changed.` The preceding rebuild-cycle case passed.
- **Aggregate result:** six passed, one live-provider opt-in skipped, one failed; exit 1 in 170.4 seconds.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-docker-0f4cfe ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-docker-owner-0f4cfe ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-container-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1`.
- **Isolated result:** both unchanged desktop/narrow cases passed, exit 0 in 18.1 seconds, against the same profile after the aggregate.
- **Evidence:** `orkestrator-test-run.Qw5tXW/merge-docker.log.gz` below the host temporary directory; screenshot, accessibility snapshot and trace under `output/agent-testing/merge-main-docker-0f4cfe/browser/`.
- **Assessment:** confirmed intermittent failure; a lifecycle operation remaining pending after the preceding rebuild scenario is supported by the refusal text, but its exact settlement race is unproven. No source, assertions, deadlines or skips changed. The profile was stopped and reset after the owning-file rerun.


## Design qualification main merge — 2026-10-21

- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-20261021-dab5ea29 mise run test:logged -- --name merge-docker -- mise run test:agent:docker`, merging `origin/main` (`d4171748`) into `a3423ada`.
- **Configuration:** one Playwright worker, rebuilt workspace development image, credential-free local/container fixture, alongside repository/browser/Electron validation and other worktrees. Host load averages reached 132 on 18 logical cores.
- **Failure:** the desktop case could not find Resources within five seconds at `container-settings.spec.ts:106`. The preceding rebuild case also failed to open its confirmation, recorded in [0518](../aggregate-validation-runs/0518-design-rerun-main-merge-docker-preview.md). No implementation or assertions changed.
- **Original result:** seven passed, two skipped, two failed; exit 1 in 573.2 seconds.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-settings-owner-dab5ea29 ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1` passed all three unchanged cases, exit 0 in 111.7 seconds, including desktop, narrow and withheld-login switch/reload coverage.
- **Evidence:** `orkestrator-test-run.I1jejv/merge-docker.log.gz` below the host temporary directory; sanitized artifacts under `output/agent-testing/merge-main-20261021-dab5ea29/browser/` and `output/agent-testing/merge-main-settings-owner-dab5ea29/browser/`.
- **Assessment:** confirmed intermittent recurrence. The exact cause remains unproven; no timeout or skip changed.

- **Cleanup (2026-10-21 merge):** `dev:stop` and `dev:reset` completed for `merge-main-20261021-dab5ea29`, removing two exact-owner containers, four volumes, one network and disposable profile state. The one-shot browser runner stopped/reset its own `qa-browser-c5dc6bca-3dd` profile. No manual profile state was retained.

## Full-network fixture recurrence — 2026-10-23 (todo 0019)

- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=q0019-residuals mise run test:logged -- --name docker-full -- mise run test:agent:docker` (01:29Z), on a profile started with `--fixture-network full --no-agent-credentials --agent-platforms codex,grok,opencode`, image `orkestrator-v2:dev-0e7293c379f3` (source `06297124`).
- **Configuration:** one Playwright worker; host load average 60–69 from other environments' runs.
- **Failure:** the desktop case did not find Resources within five seconds; the section was still showing "Checking recovery copies…". The rebuild-cycle case before it failed in the same run ([0518](../aggregate-validation-runs/0518-design-rerun-main-merge-docker-preview.md)).
- **Original result:** eight passed, two skipped, three failed (one was a bug in the new root-terminal spec, since fixed).
- **Rerun:** the same command, unchanged, at 01:45Z passed all eleven cases with two opt-in skips in 4.9 minutes. That rerun was the whole Docker set rather than the owning file alone.
- **Evidence:** lost; the run artifacts were under `/tmp` and the host rebooted afterwards.
- **Assessment:** recurrence under load. No timeout, assertion or skip changed. The profile was stopped and reset.

## Container state observation main merge — 2026-10-24

- **Parents:** feature `66a9736cc0c663bef147a65fc2d158e1951482dd` and main `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-validation mise run test:logged -- --name merge-docker -- mise run test:agent:docker`; one Playwright worker, rebuilt workspace development image `orkestrator-v2:dev-8540c28917b1`, credential-free local/container fixture, alongside other validation.
- **Failure:** the narrow case could not find Resources within five seconds (`container-settings.spec.ts:106`). The original Docker run reported ten passed, two skipped and one failed in 327.8 s logged.
- **Complete unchanged owner:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-validation ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-container-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1` passed all three cases in 138.6 s logged (133.7 s Playwright execution).
- **Evidence:** `orkestrator-test-run.tLYllM/merge-docker.log.gz` below the host temporary directory; the original aggregate remains failed.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip changed, and this observation does not establish a cause.
- **Cleanup:** `dev:stop` and `dev:reset` completed for `merge-main-validation`, removing two exact-owner containers, four volumes, one network and disposable profile state.

## Environment Files review fix — 2026-11-15

- **Branch and base:** `environment-files-1d94a340e118-r1` at `0c3077432`,
  base `f53768371` (origin/main merged in). The branch changes backend
  seed-file code, `docker/workspace-setup.sh`, tests, docs and one Settings
  help text; nothing in the container settings panel.
- **Original command:** `mise run test:agent:docker:isolated` (two shards,
  one Playwright worker each, credential-free `--fixture-environments
  local,container` profiles, rebuilt workspace image) on Linux x86_64 with
  other worktrees' validation holding host capacity.
- **Failure:** the desktop case could not find Resources within five seconds
  (`container-settings.spec.ts:104`, `getByText('Resources', { exact: true })`,
  element not found).
- **Original result:** shard one 16 passed, 5 skipped; shard two 10 passed,
  3 skipped, 1 failed (this case); exit 1. The coordinator scenario that had
  failed in this branch's earlier validation passed.
- **Complete unchanged owner:** on a fresh profile started with the runner's
  own flags,
  `ORKESTRATOR_AGENT_TEST_PROFILE=envfiles-settings-1d94 ORKESTRATOR_AGENT_TEST_RUN_ID=envfiles-settings-owner2-1d94 ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name container-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1`
  passed all three cases, exit 0 in 30.4 s. (A first attempt on a profile
  started with `--agent-platforms claude` and no credentials failed every
  case behind the "Claude Code Is Not Logged In" dialog; that was the
  profile, not this flake.)
- **Evidence:** `output/ork-docker-isolated-rerun.log` in the worktree
  (git-ignored).
- **Assessment:** recurrence under load; `mise run flaky:recurrence -- 0506`
  against this base: open, a recurrence. No implementation, assertion,
  timeout or skip changed.
- **Cleanup:** `dev:stop` and `dev:reset` completed for
  `envfiles-settings-1d94`, removing two exact-owner containers, two volumes,
  one network and disposable profile state.

## Triage note (2026-11-15)

Left `open` by the Playwright default-deadline triage. The first observation is an explicit 30 s wait in the spec that met `Another container operation is running`, a wrong state; the later 5 s Resources misses showed the section still on "Checking recovery copies…". The 2026-11-15 `expect: { timeout: 30_000 }` change in `e2e/agent-testing/playwright.browser.config.ts` may cover the latter but not the former.
