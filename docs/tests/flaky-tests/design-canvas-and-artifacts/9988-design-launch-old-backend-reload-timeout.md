# Design launch dialog: old-backend reload times out under host load

- **ID:** 9988
- **Status:** open
- **Date observed:** 2026-11-11
- **Test:** `[mobile-chromium] › old backends show upgrade guidance and recover with Check again`
- **File:** `e2e/DesignLaunchDialog.spec.ts:88`
- **Base commit:** `14df96544` (`git merge-base HEAD origin/main` on branch `20261111-141359-de945f872863`, to-dos 0038 and 7440).
- **Original command:** `env -u NODE_ENV ORKESTRATOR_E2E_PORT=1487 mise run test:logged -- --name design-agent-links-spec -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts DesignAgentLinks.spec.ts DesignLaunchDialog.spec.ts`, default workers (8 on this 16-thread host), on beelink2 (Linux) while the design-canvas perf harness ran three Chrome runs in the background and other workers shared the host (load average 55.9 over 5 minutes, 58.8 over 1).
- **Failure:** `Error: page.reload: Test timeout of 30000ms exceeded.` in the mobile project only; the desktop project's copy of the same test passed in the same run.
- **Suite counts:** 11 passed, 1 failed of 14 (the two files, both projects).
- **Isolated rerun:** `env -u NODE_ENV ORKESTRATOR_E2E_PORT=1487 mise run test:logged -- --name design-launch-spec -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts DesignLaunchDialog.spec.ts` passed all 8 tests (27.4 s) a few minutes later.
- **Changed code:** the branch adds a route (`/design-agent-links`) and a fixture file to the shared component fixture app; it does not touch the `/design-launch` route, `DesignLaunchButton` or this spec.
- **Hypothesis:** a 30 s test budget spent on a reload of the Vite dev server's fixture app under heavy host load, as in [6040](6040-static-html-specs-under-host-load.md). Unproven; not reproduced.

## Recurrence — 2026-11-11 (fix round, full browser suite)

- **Snapshot:** `dcffbcf75` on `conversation-links-de945f872863-r1` (base
  `14df96544`), the review fix round for to-dos 0038 and 7440. The recorded
  `mise run test:browser` for that round was incomplete (it waited for host
  capacity until its deadline), so it was rerun unchanged.
- **Command:** `mise run test:logged -- --name browser-rerun -- mise run test:browser`,
  default workers, on beelink2 (Linux, 16 cores) at load averages of about 88
  to 93 from other checkouts' work.
- **Failure:** the same mobile case, with the same
  `page.reload: Test timeout of 30000ms exceeded.` at `:125`.
- **Suite:** the runner's 30-minute group deadline ended the run at 720 of
  1,874 tests, with 90 failures across about 30 spec files, mostly
  `Test timeout`, `page.reload`/`page.goto` timeouts and visibility or focus
  assertions that did not settle in time. The heaviest owners were
  `CreateEnvironmentDialog` (11), `KeyboardShortcuts` (9), `PipelineFlow` (9),
  `MultiReviewFlow` (8), `EnvironmentNetworkPolicy` (6), `GlobalSettings` (5)
  and `SidebarDrag` (5). The public-site config did not run.

Owners rerun alone:

| Owner | Failure in the suite | Rerun alone |
| --- | --- | --- |
| `e2e/DesignLaunchDialog.spec.ts` (this case) | Mobile `old backends show upgrade guidance…`, `page.reload` timeout | `env -u NODE_ENV mise run test:logged -- --name design-specs-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DesignLaunchDialog.spec.ts` passed every `DesignLaunchDialog.spec.ts` case. |
| `e2e/DesignAgentLinks.spec.ts` (the branch's spec) | Started (192–194 of 1,874), not among the failures | `env -u NODE_ENV mise run test:logged -- --name design-agent-links-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignAgentLinks.spec.ts` passed (28.2 s). |
| `e2e/DesignCanvas.spec.ts:50` | Mobile `canvas edits, script isolation, missed events, conflict and reload`, test timeout | In the two-file run above and then with `--workers=1` at load about 75 to 85, both projects timed out again, at different steps (`Close inspector` at `:287`, then `Export revision 9` at `:308`). With `--workers=1 --project=desktop-chromium` (load about 73) and `--project=mobile-chromium` (load about 60) each passed (20.9 s, 12.1 s). Same owner as [9953](../aggregate-validation-runs/9953-launch-override-marker-browser-owners.md). |

The branch changes the design canvas's agent links (`DesignAgentDialog`,
`design-session-links`, an optional field on `resumeSessionLink` in
`design-client.ts`, a new fixture route) and the design perf harness. None of
the other failing owners imports those paths, and `DesignCanvas.spec.ts` never
opens the agent dialog. Host load is a hypothesis consistent with the
timeouts and with `DesignCanvas` passing once the load fell, not a confirmed
cause. No assertion, timeout or skip was changed.

Not established: the other 27 or so failing owners were not rerun alone, and
the full `mise run test:browser` (both configs) was not completed on this
snapshot. This evidence is recorded here rather than as a new case because
the run belonged to work whose flake-number range was 9988-9989. Status
stays open.
