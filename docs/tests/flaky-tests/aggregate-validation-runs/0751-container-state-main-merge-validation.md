# Container state observation main merge validation

- **ID:** 0751
- **Status:** open
- **Date observed:** 2026-10-24
- **Parents:** feature `66a9736cc0c663bef147a65fc2d158e1951482dd` and main `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`, common ancestor `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Scope:** the combined merge delta spans backend, desktop, renderer, bridges, Docker, CLI scenarios, protocol and repository tests. The original five conflicted paths and parent IDs were retained before staging in local Git metadata; validation covers the merged result.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, default workspace/root/bridge/protocol reservations 4/1/2/1. Component browser used nine workers; isolated browser, Electron and Docker checks used one worker each, alongside other worktree validation on the host.
- **Evidence:** host temporary directory `orkestrator-test-run.bFHIz7/` for the aggregate and `orkestrator-test-run.CuTY9o/merge-suite.log.gz` for its outer logged command.

## Root and support tests

The aggregate reported 3,379 passed, four failed and one error across 3,383 tests in 161 files (959.16 s). Its original exit remains failed.

Two complete unchanged owners passed separately, confirming intermittent failures:

| Failure | Aggregate observation | Complete owning-file command | Result |
| --- | --- | --- | --- |
| `baseline orchestration > releases private-origin attachments after handoff failure (att-malformed)` | `get_preview_capabilities: timed out`, 210.82 ms; the fixture uses a 100 ms request budget | `mise run test:logged -- --name merge-preview-baseline-owner -- bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1 --only-failures` | Passed, exit 0 in 4.6 s logged |
| `workspace setup Git scan caches > enables the untracked cache inside a repository` | Null subprocess status at the five-second deadline, 5035.03 ms | `mise run test:logged -- --name merge-workspace-setup-owner -- bun test ./tests/unit/workspace-setup-preserve.test.ts --parallel=1 --only-failures` | Passed, exit 0 in 14.3 s logged |

Neither observation establishes a root cause. No implementation, assertion, timeout or skip changed. Firewall and disk-report owners retained failures; see [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md) and [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md).

## Workspace owners that retained failures

- Native-command filtering observed an extra projection read in the aggregate and complete owner; see [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md).
- The validation worker reported incomplete instead of passed in the aggregate and complete owner, whose cooperative-stop stdout case also failed; see [0227](../coordinator-and-multi-review/0227-validation-cooperative-groups-incomplete.md) and [0260](../coordinator-and-multi-review/0260-validation-worker-stopped-output-empty.md).
- `standalone backend service > serves the web app and invokes backend commands without Electron` timed out waiting for startup after 20 seconds (20025.80 ms) in the aggregate. `mise run test:logged -- --name merge-standalone-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone.test.ts --parallel=1 --only-failures` retained seven startup timeouts: four passed, seven failed across eleven tests in 213.59 s. Evidence: `orkestrator-test-run.y4xprh/merge-standalone-owner.log.gz`. This observation is not newly classified as flaky.

The web package reported 9,391 passed, ten skipped and one failed across 9,402 tests in 593 files (698.70 s). Its original exit remains failed.

## Additional validation

- `mise run format:check`, `mise run lint` and `mise run typecheck`, each through a separate `test:logged` command, passed. The aggregate's bridges and pinned Codex protocol check passed.
- `mise run test:logged -- --name merge-cli -- mise run test:cli:scenarios` passed in 136.6 s.
- `mise run test:logged -- --name merge-docker-build -- mise run docker:build:dev --profile merge-main-validation` passed in 109.8 s, building `orkestrator-v2:dev-8540c28917b1` from the merged checkout.
- `ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE=orkestrator-v2:dev-8540c28917b1 mise run test:logged -- --name merge-worktree-signal-docker -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-worktree-signal-docker.test.ts --parallel=1 --only-failures` passed in 30.3 s.
- `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-validation mise run test:logged -- --name merge-docker -- mise run test:agent:docker` reported ten passed, two skipped and one failed (327.8 s logged). All three complete container-settings owner cases subsequently passed; see [0506](../environments-and-containers/0506-container-settings-rebuild-operation-pending.md).
- The unchanged `final-image-smoke.sh` failed because Codex prints `WARNING: failed to clean up stale arg0 temp dirs: Cross-device link (os error 18)` before `codex-cli 0.164.0`, while the checker keeps only the first line. Evidence: `orkestrator-test-run.vPaj6R/merge-image-smoke.log.gz`. A supplemental copy in local Git metadata selecting the final version-output line passed every agent/runtime version, bridge health and Chromium assertion in 14.7 s. The repository checker is unchanged and its original result remains failed.
- `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated` reached the runner's fifteen-minute browser deadline (933.1 s total) after gateway move returned `ECONNRESET` and the design-canvas case missed `Mock up the sidebar`. It was incomplete at test 58 of 83, and its profile `qa-browser-7f6251a9-3b6` was stopped and reset. Evidence: `orkestrator-test-run.bEbf5R/merge-agent-browser.log.gz` (ephemeral authentication cookie redacted).
- `mise run test:logged -- --name merge-electron -- mise run test:agent:electron` reported 28 passed, one skipped and three failed (1059.8 s logged): nickname refresh, multi-backend preview attachment count, and terminal-resume environment visibility. Evidence: `orkestrator-test-run.zGyXkd/merge-electron.log.gz`.
- iOS validation was omitted because the combined merge changes no iOS source or configuration.

## Cleanup

`merge-main-validation` was stopped and reset, removing two exact-owner containers, four volumes, one network and disposable state. The isolated browser runner stopped and reset its own profile. No production application instance or fixture was used.

## Electron owner outcomes

- `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-terminal-electron-owner mise run test:logged -- --name merge-terminal-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts terminal-input-resume-electron.spec.ts --workers=1` passed the complete unchanged owner: one passed (64.6 s Playwright execution). This confirms an intermittent terminal-resume environment-visibility failure; no root cause was established.
- The complete Electron-main owner retained its nickname deadline; see [0515](../electron-and-desktop/0515-electron-nickname-reload-timeout.md).
- All fourteen complete unchanged service-preview Electron owner cases passed in 228.7 s logged; see [0622](../previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md).

## Browser outcomes

- `ORKESTRATOR_E2E_PORT=64846 mise run test:logged -- --name merge-browser -- mise run test:browser` finished the component matrix with 500 passed, 101 skipped and 85 failed (1410.2 s logged, nine workers), across 29 failing owner specs. The first attempt used default port 1422 and stopped before tests because that fixture server belonged to another checkout. Evidence: `orkestrator-test-run.wLKGfy/merge-browser.log.gz`; broader component history is [0493](0493-component-browser-aggregate-timeout-cluster.md). These 85 failures are not all classified as flakes by this observation.
- `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-browser-owners ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-owner mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1` passed the original local-move case but retained two different failures: both fullscreen host-picker cases left the expected action disabled. Complete owner: twelve passed, ten skipped and two failed (325.6 s logged). Evidence: `orkestrator-test-run.f4bl1Y/merge-gateway-owner.log.gz` (ephemeral authentication cookies redacted where present). This is a failed owner result, not a complete-owner pass or a new flake classification.

- `ORKESTRATOR_E2E_PORT=64846 mise run test:logged -- --name merge-settings-browser-owner -- bunx playwright test --config e2e/playwright.config.ts GlobalSettings.spec.ts --workers=1 --output output/playwright-merge-settings` passed the complete unchanged settings owner after its two viewport reload deadlines in the component aggregate. This confirms an intermittent failure for those cases; no cause was established.
- `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-browser-owners ORKESTRATOR_AGENT_TEST_RUN_ID=merge-design-owner mise run test:logged -- --name merge-design-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts design-canvas.spec.ts --workers=1` passed both complete unchanged owner cases (47.0 s Playwright execution). This confirms an intermittent design-canvas sample-content visibility failure; no cause was established.
- `mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts` passed separately because the failed component matrix prevented the chained public-site task from running.

The owner-rerun profile `merge-main-browser-owners` was also stopped and reset after the gateway and design checks; no disposable profile state was retained.

## Final aggregate result

The complete non-iOS command finished with exit 1 in 1709.1 s logged: workspace and root/support failed; bridges and pinned Codex protocol checks passed. Backend reported 10,771 passed, 116 skipped and 32 failed across 10,919 tests in 641 files (1402.16 s). Fourteen failures were the existing OpenCode conformance mismatch: tests expect 1.19.0 while the discovered host binary reports 1.19.4; see [0740](0740-agent-accounts-sign-in-0003-validation.md). The other eighteen failures covered validation-worker and standalone startup, environment-move and project-coordinator fixtures, memory/process and Mermaid deadlines, coordinator MCP startup, Git inventory totals, provisional endpoint pins, recurring baseline timing and activity-batch re-detection. Those without complete unchanged-owner passes remain failed and unclassified in this observation; no assertion, timeout or skip was changed.

The final evidence-register contract check, `mise run test:logged -- --name merge-flake-index -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures`, passed after all record and index edits. Original conflict-document links and table columns, new evidence-document local links, the entire merged delta's conflict-marker scan, and `git diff --cached --check` also passed.

The final focused merged-runtime check, `mise run test:logged -- --name merge-runtime-integration -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/backend-runtime.test.ts ./src/core/diff-stats-container-signal.test.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures`, passed in 6.2 s. Final repository formatting also passed; a generated settings-test last-run marker was removed from its temporary output directory before this check. No generated browser output is included in the commit.

## Latest main refresh through 465e4521e — 2026-10-24

- **Parents:** previous merge `6bbc7f6f149ca855679a814054bd50050622196f` and main `465e4521e8aa30bd127efb1ddf0fbdf4c3679978`. Main advanced with Codex command-catalogue, mixed-version compatibility, and GitHub HTML rendering changes after the earlier push.
- **Conflicts:** the aggregate validation index and case 0493, the environments/container index, and the native-agent/transcript index. The complete original four-path list and both parent IDs were retained in local Git metadata before staging. Both complete case histories and every distinct case row were preserved; main's overlapping index summaries were retained, while this branch's detailed evidence remains in its cases and this record. No source conflict required manual edits.
- **Scope:** all 163 paths in the merged result's delta from the parents' common ancestor were assessed, including cleanly merged backend, storage, gateway, Codex bridge, renderer, tests and protocol code.
- **Static and documentation:** separate logged `mise run format:check`, `mise run lint`, `mise run typecheck`, and `bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` checks passed. Local Markdown targets throughout the combined delta resolved, `git diff --cached --check` passed, and no conflict markers remained.
- **Focused renderer:** `mise run test:logged -- --name refresh-renderer-owners -- bun test --cwd apps/web ./src/components/chat/MessageMarkdown.test.tsx ./src/components/pull-requests/remark-github-html.test.tsx ./src/components/build-pipeline/pipeline-transcript.test.ts ./src/lib/chat/transcript-skew.test.ts --parallel=1 --only-failures` passed (1.1 s).
- **Browser:** `ORKESTRATOR_E2E_PORT=58889 mise run test:logged -- --name refresh-browser -- bunx playwright test --config e2e/playwright.config.ts OpenCodePipelineTranscript.spec.ts GlobalSettings.spec.ts --workers=1` passed the complete pipeline-transcript and settings owners against the combined renderer.
- **CLI:** `mise run test:logged -- --name refresh-cli-scenarios -- mise run test:cli:scenarios` passed (49.6 s).
- **Known conformance owner:** `mise run test:logged -- --name refresh-opencode-policy-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/conformance-execution-policy.test.ts --parallel=1 --only-failures` reproduced the fourteen assertions expecting OpenCode 1.19.0 while the installed host binary reports 1.19.4. This remains a failed owner result; no assertion, version pin, timeout, hook or skip was changed.
- **Platform scope:** dedicated Electron, live Docker and iOS scenarios were not repeated for the incoming main delta, which changes none of those platform/lifecycle implementations. The combined backend, bridge and package suites cover their unit and contract paths; the earlier platform outcomes above retain their original dispositions.
- **Final repository result:** `mise run test:logged -- --name refresh-suite -- mise run test` completed with exit 1 after 510.3 s workspace execution. Root/support passed all 3,382 tests; all bridges and the pinned Codex protocol check passed. Web passed 9,431 tests with ten skips. Backend reported 10,796 passed, 116 skipped and fourteen failed across 10,926 tests in 644 files (414.93 s). The only workspace failure reports were the fourteen OpenCode version assertions described above; the complete conformance owner reproduced them with 56 passes and fourteen failures in 3.10 s.
- **Refresh evidence:** host temporary group artifacts `orkestrator-test-run.Fc1bqg/`, outer `orkestrator-test-run.4SP4a4/refresh-suite.log.gz`, and `orkestrator-test-run.ATR4zJ/refresh-opencode-policy-owner.log.gz`. These failed exits remain recorded. The remote main head was rechecked and still matched `465e4521e` before committing.
