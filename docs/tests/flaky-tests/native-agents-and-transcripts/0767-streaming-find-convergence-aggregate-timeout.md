# Streaming transcript find convergence times out in the component aggregate

- **ID:** 0767
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `scrollbar departure after find stays put when streaming reapplies highlights`, desktop Chromium, `e2e/StreamingTranscript.spec.ts:361`.
- **Merge parents:** `37ecb753fa8da75ae546984af7c72ba5e166d503` and `a3111c7c67e3423b161b77156c070cd105c6a489`.
- **Original command:** `ORKESTRATOR_E2E_PORT=58417 mise run test:logged -- --name main-refresh-browser -- mise run test:browser`, nine component workers alongside repository and isolated-stack validation.
- **Failure:** at line 371 the find operation's `lastOutcome` remained `unresolved` instead of `converged` for the five-second assertion deadline. The component suite reported 581 passed, 102 skipped and three failed across 686 cases (318.4 s logged); the other two failures were the already-recorded native branch suggestions.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=53198 mise run test:logged -- --name main-refresh-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/main-refresh-streaming-owner` passed (44.6 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.qIrBtp/main-refresh-browser.log.gz`; passing owner summary `orkestrator-test-run.FUNJwm/summary.json`. Original trace under `output/playwright/test-results/StreamingTranscript-scroll-bd9d1-eaming-reapplies-highlights-desktop-chromium/`.
- **Assessment:** the complete unchanged owner pass confirms an intermittent observation on the merged tree. Aggregate contention or delayed find reconciliation is a hypothesis; the cause is not established. No implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation, in the nine-worker component suite.
- **Next step:** run the owner with two workers and `--repeat-each=5` to see whether it reproduces without the nine-worker suite; if not, and it does not recur, reclassify it as environmental (see [0382](../web-ui/0382-component-browser-parallel-load.md)).

## Recurrence during search review fixes, 2026-10-27

The nine-worker component run reproduced the same unresolved-versus-converged
five-second failure on mobile. The original case passed in the complete
one-worker owner rerun, but that owner failed two different reflow cases
(mobile detached reader and desktop follower). This follow-up therefore does
not establish a complete isolated owner pass. Commands, counts, and artifacts
are recorded in [1126](../aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md#review-fix-validation-2026-10-27).
Status remains open; no assertion, timeout, or skip changed.

## Recurrence during private-TMPDIR review repair, 2026-10-29

`mise run test:logged -- --name review-browser-rerun -- mise run test:browser`
repeated the mobile failure at line 371: expected `converged`, received
`unresolved` after five seconds. The component suite used nine workers and
reported 930 passed, 105 skipped and three failed across 1,038 cases (7.7 minutes).
The other two failures were the existing native branch-picker cases.
The complete unchanged owner passed alone (exit 0, 46.5 seconds):

```sh
mise run test:logged -- --name streaming-transcript-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1
```

Failure evidence is in `orkestrator-test-run.0GmfuV/review-browser-rerun.log.gz`.
Concurrent repository validation was active; contention remains a hypothesis.
No transcript behavior, assertion, deadline or skip was changed. Status remains open.


## Project icon review validation — 2026-10-29

The mobile find-convergence case failed in preparation (`unresolved` instead of `converged`), then passed in the exact complete browser rerun.
Preparation evidence is `validation-05.stderr.txt` in
`.orkestrator/review-artifacts/review-validation-801e01fe-bc32-4c2d-bbaa-76969f1dcae2/`.

The exact `mise run test:logged -- --name browser -- mise run test:browser`
rerun reported 950 passed, 106 skipped and two failed (418.5 s). Both remaining
failures were the previously established native branch-picker cases, recorded
in [0958](../aggregate-validation-runs/0958-transcript-scroll-review-validation.md).
No assertion, timeout, skip or implementation in this owner changed.
Rerun evidence: `orkestrator-test-run.6s1hQF/browser.log.gz` under the host
temporary directory.

The separate unchanged `AgentLaunchDialog.spec.ts` owner (`native-picker-owner`,
one worker) reported two passed and the same two failed in 22.9 s: `rel`
instead of `release/2.0`. Its log is
`orkestrator-test-run.cjxAtt/native-picker-owner.log.gz`. The separately run
public-site browser suite passed (10.9 s); it was blocked by the chained
component-suite failure in the exact browser command.
