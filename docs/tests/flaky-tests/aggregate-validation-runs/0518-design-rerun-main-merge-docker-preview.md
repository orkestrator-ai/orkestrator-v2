# Docker rebuild preview during design rerun main merge

- **ID:** 0518
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `Docker fixture rebuild keeps running while another environment is open and rehydrates`
- **Owner:** `e2e/agent-testing/container-rebuild-cycle.spec.ts:57`
- **Merge:** `origin/main` at `d4171748` into `a3423ada` on `qualify-claude-design-cycle-rerun-dab5ea290ebf`. Product and test code in the merged tree matches `origin/main`; manual resolutions reconcile documentation.
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-20261021-dab5ea29 mise run test:logged -- --name merge-docker -- mise run test:agent:docker`.
- **Configuration:** one Playwright worker, a disposable local/container fixture, no host agent credentials, and the rebuilt workspace-specific image `orkestrator-v2:dev-bc962c143afd`. Repository, isolated browser and Electron validation also ran; other worktrees were active. Host load averages reached 132 on 18 logical cores.
- **Failure:** the rebuild confirmation heading was absent after 30 seconds at line 69. The saved snapshot showed the rebuild button disabled and no resource details. The cause is unproven.
- **Suite result:** seven passed, two skipped, two failed; exit 1 in 573.2 seconds. The second failure was the desktop container-settings case, which could not find Resources within five seconds. The access-only boot/restart and withheld-login switch/reload cases passed.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-rebuild-owner-dab5ea29 ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-rebuild-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-rebuild-cycle.spec.ts --workers=1` passed the complete unchanged owning file, exit 0 in 232.3 seconds.
- **Evidence:** `orkestrator-test-run.I1jejv/merge-docker.log.gz` below the host temporary directory; sanitized artifacts under `output/agent-testing/merge-main-20261021-dab5ea29/browser/`.
- **Assessment:** an intermittent failure is established by the unchanged owning-file pass. Shared host contention is a hypothesis, not a demonstrated cause. No implementation, assertions, deadlines or skips changed.


## Other merged-result validation

Formatting, linting, repository typechecking, the desktop build, workspace Docker image build and final-image smoke passed. The focused backend owners (account containers, model catalogue refresh, registry servers and portable inputs) passed with one Bun worker in 61.5 seconds. The flake-index contract passed.

`mise run test:logged -- --name merge-runtime-env-owner -- bun test ./tests/unit/runtime-env-wiring.test.ts --parallel=1 --only-failures` reported 62 passed and two five-second timeouts in 57.9 seconds; Codex and Grok setup allowlist cases remain unresolved under this host load. The file is not classified flaky from this observation.

Browser coverage remains incomplete and non-green; see [0494](../previews-annotations-and-gateway/0494-gateway-picker-diff-and-fixture-visibility.md). Electron coverage reported 19 passed, one skipped and three failed; the 60-second startup-title recurrence reopens [0470](../electron-and-desktop/0470-electron-launch-title-timeout-under-load.md). CLI scenario, iOS and live-provider suites were omitted because those scenarios were outside the merged change scope; credentialed opt-ins stayed off.

- **Cleanup (2026-10-21 merge):** `dev:stop` and `dev:reset` completed for `merge-main-20261021-dab5ea29`, removing two exact-owner containers, four volumes, one network and disposable profile state. The one-shot browser runner stopped/reset its own `qa-browser-c5dc6bca-3dd` profile. No manual profile state was retained.

The native owning-file rerun passed terminal resume but repeated the two main-window deadlines (two passed, one skipped, two failed; 382.8 seconds). Those checks remain non-green; see [0470](../electron-and-desktop/0470-electron-launch-title-timeout-under-load.md).


## Full-suite outcome

`mise run test:logged -- --name merge-tests -- mise run test` exited 1 at the logged runner's 1,800-second absolute deadline. The Codex protocol lockfile check passed. The root/support group finished with 3,136 passed, one skipped, 16 failed and two between-test errors across 149 files (1,679.11 seconds). Workspace coverage remained unfinished; bridges waited 1,784.7 seconds for host capacity and had only just started when the wrapper terminated the remaining owned process trees. This is incomplete non-IOS coverage, not a passing aggregate.

The root failures included Pi runtime staging, firewall/runtime shell fixtures, release tagging and renderer settings. The runtime-environment owner was rerun as recorded above; the other failed root files were not independently rerun, so no new flaky classification is asserted for them. The manual resolutions introduce no product or test code changes relative to `origin/main`.

Evidence: `orkestrator-test-run.EQxTI7/merge-tests.log.gz` below the host temporary directory. Partial per-group evidence remains in the private `orkestrator-test-run.ZVg6E6` directory under that same root. Static/build checks and focused backend/Docker successes do not replace the missing aggregate, browser or native-window coverage.


## Second main snapshot

While the first validation ran, main advanced. The resolved first merge was committed as `5f8b2bca`, then `origin` was fetched again and `be2e89da` merged. The second merge conflicts were the flake-index additions and todo counts. All entries were retained; this case moved from 0515 to 0518 because main already used 0515–0517, and merged todo counts were recomputed (one very high, 18 high, 266 medium, 280 low; 565 total).

The second merged tree passed `merge2-static` (`mise run check`, 16.7 seconds), the desktop build (2.2 seconds), Docker development image build (13.3 seconds), final-image smoke (8.6 seconds), backend account/container and Docker registry owners (15.5 seconds), Codex engine owner (1.1 seconds), and both container marker/runtime shell owners (7.6 seconds). Thus the earlier runtime shell timeouts passed on the later unchanged-by-resolution owner. The flake-index contract, relative links, heading anchors and conflict-marker checks passed.

Fresh credential-free local/container profile `merge2-main-20261021-dab5ea29` ran `ORKESTRATOR_AGENT_TEST_PROFILE=merge2-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge2-main-20261021-dab5ea29 mise run test:logged -- --name merge2-docker -- mise run test:agent:docker`: exit 0 in 98.5 seconds. No new renderer or Electron code was introduced by the second snapshot, so their earlier unresolved browser/native-window evidence remains the limitation instead of repeating those broad suites. The additional source changes are backend/container lifecycle and Codex account-read handling; product/test code equals the fetched `be2e89da` snapshot.


The second aggregate command was `mise run test:logged -- --name merge2-tests -- mise run test`. It was interrupted through the verified owned runner's SIGINT handler after 335.2 seconds because of continuing shared-host admission delays, following the earlier 30-minute attempt. Protocol verification completed before interruption. Root/support had reported the unchanged Pi runtime-vendor test's 30-second timeout and remained incomplete. The runner printed workspace and bridge passes at the interruption boundary; these are not treated as independent completed coverage because cancellation was already in progress. No complete aggregate pass is claimed. Evidence: `orkestrator-test-run.MGM72b/merge2-tests.log.gz` and private inner failure directory `orkestrator-test-run.Z2xRFB` below the host temporary root.

Second-profile cleanup passed: `dev:stop` and `dev:reset` removed two exact-owner containers, four volumes, one network and disposable state for `merge2-main-20261021-dab5ea29`. No profile remains live or deliberately retained.


The Pi vendor owner passed unchanged alone (`merge2-pi-vendor-owner`, 10.4 seconds); the recurrence is recorded in [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md). This does not fill the interrupted aggregate's remaining coverage.


## 2026-10-22 main merge recurrence

`main2-docker` (`mise run test:agent:docker` through `test:logged`) finished in 262.8 seconds with nine passed, two opt-in live-provider skips and one failure: the rebuilt preview did not show `Before a rebuild` after reload within 15 seconds (`container-rebuild-cycle.spec.ts:102`). The complete unchanged owner passed in 45.2 seconds using the credential-free `merge-main2-7fac-docker` fixture profile and its rebuilt checkout-specific image: `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main2-7fac-docker ORKESTRATOR_AGENT_TEST_RUN_ID=main2-docker-owner-7fac ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name main2-docker-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/container-rebuild-cycle.spec.ts --workers=1`. Aggregate evidence: `orkestrator-test-run.fXSZxE/main2-docker.log.gz` under the host temporary directory. The profile was stopped and reset. No implementation, assertion, timeout or skip changed.
