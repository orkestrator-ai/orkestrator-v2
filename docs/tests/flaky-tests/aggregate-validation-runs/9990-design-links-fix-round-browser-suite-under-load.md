# Design links fix round: full browser suite deadline-killed under host load

- **ID:** 9990
- **Status:** open
- **Date observed:** 2026-11-11
- **Snapshot:** `dcffbcf75` on `conversation-links-de945f872863-r1` (base `14df96544`), the review fix round for to-dos 0038 and 7440.
- **Why this run:** the recorded `mise run test:browser` for this round was incomplete (it waited for host capacity until its deadline), so it was rerun unchanged.
- **Original command:** `mise run test:logged -- --name browser-rerun -- mise run test:browser`, default workers, on beelink2 (Linux, 16 cores) at load averages of about 88 to 93 from other checkouts' work.
- **Result:** the runner's 30-minute group deadline ended the run at 720 of 1,874 tests, with 90 failures across about 30 spec files, mostly `Test timeout`, `page.reload`/`page.goto` timeouts and visibility or focus assertions that did not settle in time. The heaviest owners were `CreateEnvironmentDialog` (11), `KeyboardShortcuts` (9), `PipelineFlow` (9), `MultiReviewFlow` (8), `EnvironmentNetworkPolicy` (6), `GlobalSettings` (5) and `SidebarDrag` (5). The public-site config did not run.

## Owners rerun alone

| Owner | Failure in the suite | Rerun alone |
| --- | --- | --- |
| `e2e/DesignAgentLinks.spec.ts` (this branch's spec) | Started (192–194 of 1,874), not among the failures | `env -u NODE_ENV mise run test:logged -- --name design-agent-links-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignAgentLinks.spec.ts` passed (28.2 s). |
| `e2e/DesignLaunchDialog.spec.ts` | Mobile `old backends show upgrade guidance…`, `page.reload` timeout | Passed alone; recurrence of [9988](../design-canvas-and-artifacts/9988-design-launch-old-backend-reload-timeout.md). |
| `e2e/DesignCanvas.spec.ts:50` | Mobile `canvas edits, script isolation, missed events, conflict and reload`, test timeout | Alone with the default two-file run and then with `--workers=1` at load about 75 to 85, both projects timed out again, at different steps (`Close inspector` at `:287`, then `Export revision 9` at `:308`). With `--workers=1 --project=desktop-chromium` (load about 73) and `--project=mobile-chromium` (load about 60) each passed (20.9 s, 12.1 s). Same owner as [9953](9953-launch-override-marker-browser-owners.md). |

The branch changes the design canvas's agent links (`DesignAgentDialog`,
`design-session-links`, an optional field on `resumeSessionLink` in
`design-client.ts`, a new fixture route) and the design perf harness. None of
the other failing owners imports those paths, and `DesignCanvas.spec.ts` never
opens the agent dialog. Host load is a hypothesis consistent with the
timeouts and with `DesignCanvas` passing once the load fell, not a confirmed
cause. No assertion, timeout or skip was changed.

## Not established

The other 27 or so failing owners were not rerun alone, and the full
`mise run test:browser` (both configs) was not completed on this snapshot.
