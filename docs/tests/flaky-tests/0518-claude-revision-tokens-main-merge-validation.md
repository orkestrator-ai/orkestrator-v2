# Claude revision-token main-merge validation

- **ID:** 0518
- **Status:** open
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

## Follow-up merge of current main — 2026-10-21

The follow-up merges fetched `origin/main` at `539335f9` into `4fee8400`.
The incoming delta contains 335 paths, including 275 non-Markdown paths whose
staged contents were verified identical to the fetched main tree. Conflicts
were limited to the flake index, case 0178 and the todo index. Both branches'
records were retained. The merged checklist has one very-high, 15 high,
269 medium and 284 low items (569 total), and its per-file counts agree.
An incoming link to the untracked `docs/temp/remote.md` plan was made a plain
historical reference; an extra blank line at EOF was removed from that document.
All 1,594 local link targets in the incoming documents then resolved.

All checks below used `mise run test:logged -- --name <label> -- <command>`.

| Label | Command | Outcome |
| --- | --- | --- |
| `revtok-main2-format` | `mise run format:check` | Passed, 0.5 s. |
| `revtok-main2-lint` | `mise run lint` | Passed, 1.5 s, with incoming warnings retained. |
| `revtok-main2-types` | `mise run typecheck` | Passed, 7.5 s. |
| `revtok-main2-runner` | `bun test ./tests/unit/test-all.test.ts --parallel=1 --only-failures` | Passed, 5.1 s. |
| `revtok-main2-build` | `mise run build` | Passed, 64.3 s. |
| `revtok-main2-browser` | `mise run test:browser` | Passed, 221.5 s. |
| `revtok-main2-isolated` | `mise run test:agent:browser:isolated` | Passed, 478.1 s, including disposable-profile cleanup. |
| `revtok-main2-docker-build` | `mise run docker:build:dev --profile revtok-main2-docker` | Passed, 102.5 s. |
| `revtok-main2-cli` | `mise run test:cli:scenarios` | Passed, 25.7 s. |
| `revtok-main2-electron` | `mise run test:agent:electron` | Passed, 142.3 s (29 passed, one skipped); run ID `revtok-main2-electron`. |
| `revtok-main2-tests-warm` | `mise run test` | Passed all four groups, 526.0 s, after the registry metadata correction. |

Both root and Claude-bridge `bun install --frozen-lockfile` checks passed with
the pinned Bun 1.4.3. The test-runner change adds a support fixture to the root
group, so both first and warm full-suite observations are required.

### First aggregate and owner reruns

`revtok-main2-tests-first` ran `mise run test`, with 4/1/2/1 workspace/root/
bridge/protocol slots and no admission wait. It exited 1 after 567.4 seconds.
Workspace passed in 566.9 s, bridges in 184.9 s and protocol regeneration in
0.745 s. Root/support reported 3,185 passed, one skipped and two failed across
152 files (317.65 s).
Component/public browser checks, isolated browser checks and the Docker image
build also ran during the first aggregate. The subsequent warm full run passed
all four groups in 526.0 seconds without changing test assertions or deadlines.

- Pi runtime vendoring timed out at 30,000.05 ms. The complete unchanged
  owning file passed alone in 15.0 seconds under label `revtok-main2-pi-owner`,
  using `bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`.
  This is another confirmed intermittent occurrence, with no assertion or
  deadline change.
- The registry test rejected this case's earlier status line, which included
  explanatory text after `open`. That metadata defect was corrected to the
  exact `- **Status:** open` contract. The complete
  `flaky-tests-index.test.ts` owner passed under label
  `revtok-main2-register-owner` in 0.2 seconds. This was a real documentation
  defect, not a flake.
- Evidence: `orkestrator-test-run.N17jIb/revtok-main2-tests-first.log.gz` and
  `orkestrator-test-run.zKcvZA/summary.json` below the host temporary directory.

### Docker and gateway owner

Profile `revtok-main2-docker` was created with
`mise run dev:test --profile revtok-main2-docker --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex`.

- With `ORKESTRATOR_AGENT_TEST_PROFILE=revtok-main2-docker` and run ID
  `revtok-main2-docker`, `mise run test:agent:docker` returned nine passed,
  two credentialed scenarios skipped and one failed in 88.4 seconds.
  The new command-only seed-file case observed Docker `cat` exit 1 at
  `browser-gateway.spec.ts:2663`; it expected exit 0. All other ordinary Docker
  cases, including rebuild and settings rehydration, passed. Evidence:
  `orkestrator-test-run.Dnyw0Z`.
- The complete unchanged `browser-gateway.spec.ts` was rerun with the same
  profile, run ID/label `revtok-main2-gateway-owner`,
  `ORKESTRATOR_AGENT_TEST_DOCKER=1`, `ORKESTRATOR_AGENT_TEST_REVIEW=0`, and
  `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
  Result: 17 passed, four skipped and three failed, 161.1 seconds. It reproduced
  the seed-file read failure, and also failed the narrow Repository settings
  click and the 390px host-maintenance navigation case. Evidence:
  `orkestrator-test-run.OI6aTH`; sanitized artifacts are under
  `output/agent-testing/revtok-main2-gateway-owner/browser/`.
- These Docker/gateway observations remain unresolved; this owning-file run
  does not establish them as flakes. No source, assertion, deadline or skip
  was changed to conceal the failures.
- `dev:stop` and `dev:reset` succeeded for `revtok-main2-docker`. Reset removed
  two exact-owner containers, four volumes, one network and disposable state;
  its launcher exited on the requested stop.

Live paused-interaction/provider suites retained their explicit credential and
billing opt-ins. iOS was omitted because no iOS implementation changed.

## Third merge of current main — 2026-10-22

Fetched `origin/main` at `3b1c82de45355a7b8df69d0eb4d7ff2cf3831f8b` and
merged it into pre-merge HEAD `6016905d164d507d982811888bbf91d770ce372e`.
The incoming delta contains 164 paths, including 135 non-Markdown paths
whose staged contents match the fetched main tree exactly. Branch-specific
revision-token readers, isolated-runner behavior and live qualification
coverage remain intact.

Conflicts were limited to `docs/architecture/command-nodes.md` and the flake
index. The architecture guide uses main's current wording for the historical
remote-plan draft, without restoring its broken link. The index retains all
367 case references from both parents and both branches' observations for
cases 0248, 0247 and 0178. Case 0178's narrative auto-merged. All 412 local link
targets in the incoming Markdown resolve, and no conflict markers remain.

All checks below used `mise run test:logged -- --name <label> -- <command>`.

| Label | Command | Outcome |
| --- | --- | --- |
| `revtok-main3-format` | `mise run format:check` | Passed, 0.4 s. |
| `revtok-main3-lint` | `mise run lint` | Passed, 0.8 s; incoming warnings retained. |
| `revtok-main3-typecheck` | `mise run typecheck` | Passed, 9.6 s. |
| `revtok-main3-build` | `mise run build` | Passed, 26.5 s. |
| `revtok-main3-focused` | `bun test ./tests/unit/flaky-tests-index.test.ts ./tests/unit/claude-revision-token-reader.test.ts ./tests/unit/version-drift.test.ts --parallel=1 --only-failures` | Passed, 0.8 s. |
| `revtok-main3-web-owners` | `bun test --cwd apps/web ./src/lib/portal/workspace-switch.test.ts ./src/lib/portal/portal-transport.test.ts ./src/components/federation/FederationProvider.test.tsx ./src/hooks/useVirtuosoScrollState.test.ts ./src/hooks/useWorkspaceSwitchSelection.test.tsx --parallel=1 --only-failures` | Passed, 4.9 s. |
| `revtok-main3-public` | `bunx playwright test --config e2e/public-site/playwright.config.ts` | Passed, 12.4 s, after the first component failure prevented the combined task's public stage. |
| `revtok-main3-browser-retry` | `mise run test:browser` | Passed, 180.1 s, including public-site coverage. |
| `revtok-main3-electron` | `mise run test:agent:electron` | Passed, 242.7 s. |
| `revtok-main3-isolated` | `mise run test:agent:browser:isolated` | Passed, 502.8 s; 29 passed, 43 existing opt-in skips. Profile `qa-browser-e1d6c9ea-144` stopped and reset automatically. |
| `revtok-main3-registry-final` | `bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` | Passed, 0.5 s after recording the recurrences. |

Root and Claude-bridge frozen installs passed with pinned Bun 1.4.3. No package
script, test-runner implementation, Docker lifecycle, CLI implementation or
iOS implementation changed in this incoming delta. Docker, CLI scenario and
iOS suites were therefore omitted. Billed/provider scenarios retained their
explicit opt-ins. The ordinary isolated fixture does not qualify the new
workspace switch against two real backends; the imported command-node handoff
document retains that limitation.

### Initial aggregate and unchanged owner reruns

`revtok-main3-tests` ran `mise run test` with 4/1/2/1 workspace/root/bridges/
protocol slots alongside component, isolated browser and Electron checks. It
exited 1 after 626.6 s. Workspace passed (626.6 s), including all 9,911 backend
tests (68 existing skips). Protocol passed (0.705 s). Root/support had
3,200 passed, one skipped, one failed and one error (316.88 s); bridges failed
only the fake Codex version/invocation case (134.3 s group time).

- Disk-report checkout fixture: five-second deadline at 5044.81 ms and null
  process status; unchanged complete owner passed in 1.7 s under
  `revtok-main3-disk-owner`. See case 0259 for command and evidence.
- Fake Codex process: five-second deadline at 5027.15 ms; unchanged complete
  owner with the bridge's Node preload passed in 0.2 s under
  `revtok-main3-codex-owner-node`. See case 0210.
- First component-browser run: 398 passed, 81 skipped and one failed; the
  mobile native transcript-paging case observed 244.5 px offset drift instead
  of less than 3 px. Its complete unchanged eight-case owner passed in 44.9 s;
  the full component/public task subsequently passed. See case 0483.
- Aggregate evidence: `orkestrator-test-run.YKWNcv/summary.json` and compressed
  group logs; wrapper evidence `orkestrator-test-run.xQ6nby`, below the host
  temporary directory. First component evidence: `orkestrator-test-run.9O0EhD`.
- The first component logs also contain `source.listen is not a function`
  fixture console diagnostics from incoming main; a passing retry does not
  establish console-clean fixtures.

These observations establish intermittent recurrences through complete
unchanged owning-file passes. Shared-host/render timing remains a hypothesis.
No implementation, assertion, deadline or skip was changed to conceal a
failure. The full non-iOS suite was rerun after the owner checks.

### Final full-suite result

`mise run test:logged -- --name revtok-main3-tests-retry -- mise run test`
passed all four groups in 400.0 s after the browser and Electron checks
finished. Root/support passed in 173.4 s, bridges in 104.8 s and protocol
regeneration in 0.444 s. No code, assertion, deadline or skip changed between
aggregate runs. Summary: `orkestrator-test-run.9g84yw/summary.json` below the
host temporary directory. The initial failed aggregate and component results
remain recorded above; their unchanged owners and the final complete runs
passed.
