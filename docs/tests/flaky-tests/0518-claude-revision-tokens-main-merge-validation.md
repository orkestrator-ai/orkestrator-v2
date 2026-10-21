# Claude revision-token main-merge validation

- **ID:** 0518
- **Status:** open; validation remains non-green
- **Observed:** 2026-10-21
- **Merge:** `origin/main` at `d4171748` into `86ac54bb` on
  `qualify-claude-inactive-tab-revision-tokens-2ead11fcd0c8`.
- **Scope:** all 44 paths changed from the pre-merge HEAD were reviewed,
  including incoming source, configuration, tests and documentation. Conflicts
  were confined to the flake and todo indexes. Both branches' observations
  were retained and todo counts were recalculated. An incoming broken link in
  case 0248 was corrected to case 0513.

## Static and build checks

`mise run format:check`, `mise run lint`, `mise run typecheck` and
`mise run build`, each through `mise run test:logged -- --name <label> --`,
passed. Lint retained its pre-existing warnings. Formatting was checked again
after the documentation correction. All 1,266 local Markdown link targets in
the originally changed documents resolved; both staged and unstaged whitespace
checks and the conflict-marker scan were clean.

## Non-iOS aggregate

`mise run test:logged -- --name merge-tests -- mise run test` exited 1 after
1,801.0 seconds. Workspace/root/bridges/protocol requested 4/1/2/1 slots on
an 18-slot host. At admission, other work occupied 17 slots.

- Root/support ran with one worker: 3,149 passed, one skipped, 17 failed and
  four between-test errors across 150 files, in 1,665.64 seconds.
- Workspace never acquired four slots and returned infrastructure status 75
  after 1,799.4 seconds, with zero output. This run supplies no workspace-suite
  pass evidence.
- Bridges and Codex protocol regeneration passed after their queue waits.
- Evidence below the host temporary directory:
  `orkestrator-test-run.9xQwfo/merge-tests.log.gz` and
  `orkestrator-test-run.fDvtOM/summary.json`, with the latter directory's
  compressed group logs.

Each failing root file was rerun alone, unchanged, using
`mise run test:logged -- --name <label> -- bun test ./<file> --parallel=1 --only-failures`:

| Owner under `tests/unit/` | Rerun outcome |
| --- | --- |
| `runtime-env-wiring.test.ts` | Passed, 18.4 s; the aggregate's Codex setup case timed out at 5,031.67 ms. |
| `firewall-policy.test.ts` | Passed, 12.5 s. |
| `release/release-desktop.test.ts` | Passed, 5.2 s. |
| `components/GitHubCloneIntegration.test.tsx` | Passed, 3.8 s. |
| `components/GlobalSettingsDefaults.test.tsx` | Passed, 7.2 s. |
| `test-diagnostic-bounds.test.ts` | Passed, 9.3 s. |
| `disk-report.test.ts` | Failed alone: four passed, one failed and one error; subprocess status was null after the five-second timeout. Evidence: `orkestrator-test-run.LnNXTe`. This occurrence is unresolved, not independently established as a flake. |
| `pi-bridge-vendor.test.ts` | Failed alone: three passed, one failed at 30,000.45 ms. Evidence: `orkestrator-test-run.n1mHiG`. This occurrence is unresolved, not independently established as a flake. |

The six passing unchanged owners establish intermittence for their aggregate
failures. Shared host contention is a hypothesis, not a proved cause.

## Focused coverage of incoming code

- `merge-backend-owners`: the changed `agent-accounts-containers`,
  `host-model-catalog-refresh`, `commands-integration`,
  `commands-registry-servers` and `portable-inputs` test files ran with
  `bun test --cwd apps/backend <explicit paths> --parallel=1 --only-failures`.
  Result: 130 passed and two failures in `commands-integration.test.ts`,
  121.0 seconds. Its existing Files-panel cache test observed an extra Git
  status call, and local-server deletion exceeded five seconds.
- `merge-command-owner`: the complete unchanged `commands-integration.test.ts`
  then passed alone in 20.4 seconds. Initial evidence:
  `orkestrator-test-run.y1UAsf`.
- `merge-desktop-owners`: `scripts/dev/profile-io.test.ts` and
  `tests/backend-process.test.ts` passed together with one isolated worker in
  110.6 seconds.
- `merge-protocol-owner`: `packages/protocol/src/login-snapshots.test.ts`
  passed alone in 0.5 seconds.
- `merge-web-owner`: the complete
  `EnvironmentInputsSection.test.tsx` passed alone in 0.9 seconds.
- Every focused command used `test:logged`; no test implementation, assertion,
  timeout or skip was changed.

## Browser and Electron checks

- `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`
  exited 1 after 930.9 seconds. Profile `qa-browser-1afaafc0-f32` scheduled
  71 tests but reached the runner's 15-minute browser deadline. The narrow
  host picker could not find its project-drawer button; signed-out Codex
  recovery timed out at 120 seconds. The runner stopped and reset the profile.
  Evidence: `orkestrator-test-run.ebSlLm`; browser artifacts under
  `output/agent-testing/qa-browser-1afaafc0-f32/browser/`.
- The complete unchanged `browser-gateway.spec.ts` passed in a fresh,
  credential-free local fixture profile, `merge-main-browser-owner`, in
  178.4 seconds (14 passed, nine skipped). Command:
  `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-browser-owner ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-gateway-owner ORKESTRATOR_AGENT_TEST_DOCKER=0 ORKESTRATOR_AGENT_TEST_REVIEW=0 mise run test:logged -- --name merge-main-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
  This confirms intermittence for both observed browser failures, but does
  not turn the incomplete full browser run into a pass. `dev:stop` and
  `dev:reset` succeeded for the owning-file profile.
- `mise run test:logged -- --name merge-electron -- mise run test:agent:electron`
  exited 1 after 818.9 seconds: ten passed, three failed, one skipped and nine
  did not run. Failures were the two independent-window cases in
  `electron-main.spec.ts` and the Home preview case in
  `web-annotations-electron.spec.ts`. Evidence: `orkestrator-test-run.7oJtr3`.
- Whole-file Electron main rerun:
  `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-electron-owner mise run test:logged -- --name merge-main-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts --workers=1`.
  It still failed: one passed, two failed, one skipped, 248.6 seconds. The
  failures were a native window-focus poll and a remote-nickname poll. The
  original clipboard symptom did not recur. These native-window checks remain
  unresolved. Evidence: `orkestrator-test-run.NNcmjA`.
- The complete unchanged `web-annotations-electron.spec.ts` passed alone
  in 65.4 seconds, confirming intermittence for the Home-preview failure:
  `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-annotations-owner mise run test:logged -- --name merge-main-annotations-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/web-annotations-electron.spec.ts --workers=1`.

## Docker checks

- `mise run test:logged -- --name merge-docker-build -- mise run docker:build:dev --profile merge-main-qa`
  stopped after 544.1 seconds when copying the Pi bridge layer produced no
  output for five minutes. Evidence: `orkestrator-test-run.leJiHZ`.
- The same image build passed in 439.6 seconds with
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=900000` and label
  `merge-docker-build-retry`. Only the build-output watchdog changed; no test
  deadline changed. The image was `orkestrator-v2:dev-66f2cac39c35`.
- Profile command:
  `mise run dev:test --profile merge-main-qa --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex`.
- `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-qa ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-docker mise run test:logged -- --name merge-main-docker -- mise run test:agent:docker`
  returned eight passed, two credentialed checks skipped and one failed in
  446.4 seconds. Access-only Codex/Grok boot and restart, ownership, deletion,
  the container's Playwright browsers, settings at both widths, and the
  withheld-login summary across switching and reload passed. Rebuild recovery
  could not find `Before a rebuild` after reload. Evidence:
  `orkestrator-test-run.uKe2F1`.
- The unchanged whole `container-rebuild-cycle.spec.ts` rerun under the same
  profile and `ORKESTRATOR_AGENT_TEST_DOCKER=1`, using label/run ID
  `merge-main-rebuild-owner`, reproduced that assertion failure in 92.6
  seconds. Teardown also rejected its trace at the 16 MiB sanitization bound.
  Evidence: `orkestrator-test-run.q0aLAB`. This is unresolved, not a confirmed
  flake from this observation.
- `dev:stop` and `dev:reset` succeeded for `merge-main-qa`; reset removed
  three exact-owner containers, six volumes, one network and disposable state.

Credentialed live-provider scenarios retained their opt-ins. CLI scenarios and
iOS were omitted because those areas did not change. Validation failures are
reported without weakening coverage or treating failed owner reruns as flakes.
