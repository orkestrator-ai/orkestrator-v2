# Cross-cutting

Work that spans the product: CI and test health, live provider and platform qualification, mixed-version support, dependency upgrades, remote host upgrades and mobile layout.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md) | Very high | No | Applying the approved required-check ruleset once `main` is green again, slow backend owners, Electron main-process bookkeeping tests, dev-tooling defects, deferred test-structure candidates. | `main` has no required-check ruleset yet, so a broken release can merge unguarded; the fix for its red CI is not yet on `main`. |
| 2 | [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md) | Medium | No | Shared prerequisites and a batching index for live-provider and platform runs, agent-test profile isolation, and checks with no other home. | Claude container credentials are access-only; shared prerequisites, provider binary resolution and remaining platform qualification still gate live runs elsewhere. |
| 3 | [0032-dependency-upgrades.md](0032-dependency-upgrades.md) | Medium | No | Non-agent dependency upgrades still pending: Electron 46, React Compiler lint warnings, update-signing decision, and upgrades blocked upstream or deferred. | Electron 44 loses support on 2027-03-02, so its upgrade has a deadline; the rest is lint debt and blocked upgrades. |
| 4 | [0033-remote-host-upgrades.md](0033-remote-host-upgrades.md) | Medium | No | Real-release qualification of remote host maintenance (desktop update between signed releases, the standalone launchd/systemd service with rollback, image and gh updates) and two known limitations. | Shipped remote host maintenance still needs evidence from real signed releases. |
| 5 | [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md) | Medium | No | Support-window policy for old clients, bridges and backends; renderer–backend skew; dead prompt-queue claim commands; index of compatibility paths awaiting retirement. | No written support window for old clients, bridges and backends, and dead prompt-queue claim code to remove. |
| 6 | [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md) | Medium | No | Narrow-viewport follow-ups: one host for environment settings, focus return from settings, real-phone qualification. | Both mobile fixes are in; a breakpoint-crossing spec and a real narrow-browser check remain. |
| 7 | [0056-agent-test-stale-bridge-builds.md](0056-agent-test-stale-bridge-builds.md) | Medium | No | `dev:test` profiles and live suites run whatever `bridges/*/dist` is on disk, with no rebuild or freshness check. | A live run after a bridge change silently tests the old build and spends real tokens doing so; contributors can work around it by building by hand. |
| 8 | [0055-persistent-terminal-readiness-tests.md](0055-persistent-terminal-readiness-tests.md) | Low | Yes | Output-gated non-first-tab launch and a second bootstrap after a container move, verified with controlled clocks and mutation checks. | Both coverage gaps are closed; removing either readiness check makes its tests fail. |
| 9 | [0054-agent-test-pi-default-model.md](0054-agent-test-pi-default-model.md) | Low | Yes | The bridge starts on Pi's saved default model, and agent-test profiles receive the host's; the live Pi coordinator rerun passed all four scenarios on 2026-10-23. | Nothing is left; the fresh-install fallback question moved to 0062. |
