# 09 — Add native, container, and platform qualification

Status: Not started. Depends on: 04, 06, 08. Finding: T1 and platform scope.

[Plan index](00-index.md) · [Previous](08-browser-ci.md) ·
[Next](10-evidence-retention.md)

## Outcome

Give native Electron behavior, real containers, iOS execution, and provider
compatibility explicit qualification lanes. A successful image build or packaged
backend smoke must not be described as proof of every platform user flow.

## Lane matrix

| Lane | Proposed trigger | Required evidence |
| --- | --- | --- |
| Linux Electron | PRs touching desktop/preload/native transport and shared dependencies; scheduled broad run | Real main/preload/IPC, window lifecycle, clipboard, shutdown |
| macOS Electron | Scheduled and release candidate; targeted desktop changes where capacity permits | Same contract on macOS, platform-specific lifecycle |
| Docker fixture | Container/backend lifecycle changes; scheduled/release run | Start/use/stop owned fixture and reject another owner's container |
| iOS | iOS/shared mobile-contract changes and release candidate on macOS/Xcode | An executed iOS suite, not merely success of a non-iOS aggregate |
| Live provider compatibility | Explicit scheduled/manual trusted qualification for relevant upgrades | Named provider/version, exercised contract, missing capabilities |

Path selection must include protocol, root manifests/lockfiles, task definitions,
runtime pins, and relevant fixture changes. Use an always-reporting gate if a
lane becomes required; a filtered-out workflow must not strand a PR check.

## Owners

- `.github/workflows/validate-bun-runtime.yml`: existing architecture/package
  validation; preserve it and decide whether to extend or add focused jobs.
- `e2e/agent-testing/electron-main.spec.ts` and Electron config.
- Docker sections of `browser-gateway.spec.ts` and dev image/profile helpers.
- `scripts/test-ios.ts`, the iOS project, and aggregate suite-scope metadata.
- Existing `verify:opencode:live`, `verify:toolchains:live`, and upgrade runbook.

## Native Electron tasks

- [ ] Run the real Electron suite on a suitable display-enabled/virtual-display
      Linux runner. Isolate userData, ports, output, and backend registry.
- [ ] Verify main process, preload, multi-window ownership, clipboard, startup,
      and shutdown assertions actually execute.
- [ ] Report the native Wayland/fractional-scale case separately when the runner
      lacks its display capability. Xvfb success does not cover native Wayland.
- [ ] Add macOS qualification with equivalent profile ownership and cleanup.
      Do not seed Keychain/provider credentials into ordinary CI profiles.
- [ ] Apply step 06's artifact finalization to native traces/screenshots and
      ensure profile teardown is independent of test success.

## Docker tasks

- [ ] Build/use the workspace-specific development image and copied fixture.
      Never use or retag `orkestrator-v2:latest` as a disposable test image.
- [ ] Start a profile with the explicit container fixture selection and run the
      opt-in Docker browser suite through the logged wrapper.
- [ ] Assert the owner-mismatch rejection and both container-user browser launch
      cases, plus the affected lifecycle operation when changing containers.
- [ ] Preserve exact owner labels/IDs through cancellation and cleanup. Verify
      foreign-owner containers survive the test's cleanup path.
- [ ] Record host/container scheduler namespaces accurately. Host admission
      does not impose a physical-host CPU quota across Docker namespaces.
- [ ] Cache immutable image layers when useful, but rebuild changed fixture/
      runtime layers and execute tests anew.

## iOS tasks

- [ ] Choose a supported macOS/Xcode runner and simulator configuration from
      current repository settings. Verify the environment before execution.
- [ ] Run the dedicated iOS task, or require an executed iOS inventory result
      from `test:all`. A zero exit from the non-iOS fallback is insufficient.
- [ ] Preserve simulator/host exclusivity and existing process cleanup. Use a
      fresh simulator state when required by the scenario, without broad device
      deletion that can affect another job/user.
- [ ] Retain bounded build/test failure results and explicitly record no-tests-
      executed, toolchain unavailable, and simulator-start failure outcomes.

## Provider qualification tasks

- [ ] Keep PR smoke credential-free. Run live-provider tests only in a trusted,
      explicitly configured context using the established isolated-profile rules.
- [ ] Start with existing live compatibility probes rather than adding a paid
      model turn to every test. Local mock-model compatibility is a useful
      distinct layer and should be named accurately.
- [ ] Map agent/SDK version upgrades to the existing upgrade runbook's required
      protocol, packaging, patch, and live compatibility checks.
- [ ] Record which providers/features executed and which were unavailable.
      “All tests passed” cannot stand in for an unexecuted provider matrix.

## Acceptance and rollout

For each lane demonstrate one pass, one deliberately induced meaningful failure,
and cleanup after interruption. Remove deliberate faults before handoff. Record
capability-specific skips rather than loosening assertions for CI convenience.

Stage lanes independently. Missing macOS capacity must not delay Linux browser
enforcement, but the macOS/iOS step remains incomplete until its actual execution
evidence exists. Do not mark unavailable infrastructure as implemented coverage.

Use measured duration/cost to choose scheduled frequency. A maintainer decides
which stable jobs become required. Release documentation must list actual
qualified platforms and outstanding limitations, including Wayland and providers.
