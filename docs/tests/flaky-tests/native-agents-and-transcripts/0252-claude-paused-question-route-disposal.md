# Paused Claude question test races request-context disposal

- **ID:** 0252
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `[mobile-chromium] a paused Claude question stays paused across a reload, then resumes and answers`
- **Owning file:** `e2e/ClaudeInteractions.spec.ts:100` (route callback at `:107`)
- **Original command:** `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name merge-browser -- mise run test:browser` on `multi-review-flow-graph-followups` while merging `origin/main`.
- **Worker configuration:** 9 Playwright workers; repository tests were also running on the shared host.
- **Failure:** `apiRequestContext.fetch: Request context disposed` while the route callback fetched a session snapshot; Playwright reported a request still in flight during teardown.
- **Suite counts:** 298 passed, 63 skipped, 1 failed across 362 cases (2.7 minutes; logged command 161.7 seconds).
- **Isolated owning-file rerun:** `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name merge-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed unchanged (23.2 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.N9elob/merge-browser.log.gz`.
- **Hypothesis:** a snapshot request remains in flight when the test disposes its request context; parallel load may widen the teardown race. Not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Keep-open picker coverage validation — 2026-10-18

- **Original command:** `mise run test:logged -- --name picker-browser -- mise run test:browser`, alongside the full repository suite on macOS.
- **Workers:** nine Playwright workers.
- **Failure:** the mobile paused-question case raised `apiRequestContext.fetch: Target page, context or browser has been closed` from the route callback at line 107 during teardown.
- **Suite counts:** 351 passed, 80 skipped, one failed across 432 cases (144.8 seconds logged). All picker cases passed.
- **Owning-file rerun:** `mise run test:logged -- --name claude-interactions-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output=output/playwright/claude-interactions-owner` passed unchanged (19.5 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fPWiLQ/picker-browser.log.gz`.
- **Assessment:** confirmed intermittent recurrence; no Claude implementation, assertion, timeout or skip changed. The public-site smoke suite, which the component failure prevented from starting, passed separately.

## Transcript-paging final validation — 2026-10-18

The desktop variant repeated the same request-context disposal during
`mise run test:logged -- --name committed-browser-suite -- mise run test:browser`
on commit `3dd86696`. All transcript-paging cases passed; component suite counts
were 359 passed, 80 skipped and one failed (124.8 seconds logged).

The unchanged owner passed both viewport projects alone in 11.7 seconds:

```bash
mise run test:logged -- --name claude-interactions-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.19DYL2/committed-browser-suite.log.gz`.
No interaction test, timeout, assertion or product behavior changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Setup recovery browser regression validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`, alongside the default suite and isolated application browser validation.
- **Workers:** nine Playwright workers.
- **Failure:** mobile paused-question case raised `route.fulfill: Fetch response has been disposed` at line 111.
- **Suite counts:** 367 passed, 80 skipped and three failed across 450 cases (226.6 seconds logged). The other two failures were native branch selection; all four new setup recovery cases passed.
- **Owning-file rerun:** `mise run test:logged -- --name claude-interactions-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed unchanged (exit 0, 14.3 seconds logged).
- **Evidence:** `orkestrator-test-run.t17PN5/browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. No implementation, assertion, timeout or skip changed. The public-site suite, blocked by the component failure in the combined task, passed separately (12.0 seconds).

The separate native branch-selection owner rerun also failed unchanged at both viewport widths (two passed, two failed, 21.3 seconds): `mise run test:logged -- --name native-branch-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`. The input remained `rel` instead of `release/2.0`. This observation does not establish a flake for native branch selection. Evidence: `orkestrator-test-run.vQfkZW/native-branch-browser-isolated.log.gz`.

## Transcript scroll smoothness validation — 2026-10-24

- `mise run test:logged -- --name scroll-browser -- mise run test:browser`
  (528 passed, 101 skipped, 3 failed) failed the desktop case with
  `apiRequestContext.fetch: Target page, context or browser has been closed`
  while running a route callback — the same response disposal.
- The unchanged owning file passed alone with one worker on both this branch
  and its base commit `f12cc5a53`:
  `bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/ClaudeInteractions.spec.ts --workers=1`
  (ClaudeInteractions cases all passed).

## Refresh through 95c9cb46a — 2026-10-24

The desktop paused-question case again raised `apiRequestContext.fetch: Request context disposed` in the route callback at line 107 during the nine-worker `mise run test:logged -- --name refresh-95c9-browser -- mise run test:browser` run (579 passed, five failed, 102 skipped; 254.2 s). The complete unchanged owner passed with one worker in 13.5 s: `ORKESTRATOR_E2E_PORT=64238 mise run test:logged -- --name refresh-95c9-owner-ClaudeInteractions -- bunx playwright test --config e2e/playwright.config.ts ClaudeInteractions.spec.ts --workers=1 --output output/playwright/refresh-95c9-ClaudeInteractions`. Evidence: host temporary artifact `orkestrator-test-run.6yNWW5/refresh-95c9-browser.log.gz`. This confirms a recurrence; no assertion, timeout, skip or implementation changed. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the merge parents and other validation outcomes.


## Codex MCP startup coverage validation — 2026-10-28

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Failure:** desktop paused-question route callback at line 107 raised `apiRequestContext.fetch: Request context disposed`.
- **Suite:** nine workers; 874 passed, 105 skipped and three failed (630.2 s logged). The other two failures were native branch selection in both viewports.
- **Complete unchanged owner:** `mise run test:logged -- --name browser-claude-recheck -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed (16.8 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.HOuu35/browser.log.gz`.
- **Assessment:** recurrence of the recorded disposal race. No Claude code, assertions, timeout or skip changed. Native branch selection also failed in its unchanged one-worker owner (two passed, two failed; 23.4 s), so it is not classified as a flake here. Its evidence is `orkestrator-test-run.eQ4vHu/browser-branch-recheck.log.gz`.

## Claude paused-question reload: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).

## Session-import review validation — 2026-11-01

`mise run test:logged -- --name review-fixes-component-browser -- mise run test:browser`
reproduced the desktop `apiRequestContext.fetch: Request context disposed`
error in the snapshot route callback at line 107. The nine-worker component run
had 1,052 passed, 108 skipped and six failed (629.1 seconds); the other failures
were the existing design layer-tree case and four Cursor retention fixtures.
This owner and the Claude implementation were unchanged by the preview fixes.

The complete unchanged owner passed alone with
`mise run test:logged -- --name claude-interactions-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output=output/playwright/session-import-review-claude-owner`
in 17.7 seconds. This confirms another intermittent recurrence; no assertion,
timeout or skip was changed. Evidence is the aggregate compressed log
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.P117Rf/review-fixes-component-browser.log.gz`
and the isolated owner's passing `.last-run.json` under
`output/playwright/session-import-review-claude-owner/`.

## To-do 1202 task 3 renderer review — 2026-11-02

Branch `renderer-paths-optimization-845c78394eb7-r1` (head `19e1baf42`), which
changes pane-layout persistence, native-session in-flight flags, the agent-info
header and the native tab's transcript tail reads, not the Claude interaction
cards or this fixture's route proxy. A three-worker rerun of the 18 owners that
failed in the loaded nine-worker `test:browser` run
(`bunx playwright test --config e2e/playwright.config.ts --workers=3 …`, 278
passed, 43 skipped, 5 failed in 4.3 min) failed the mobile case at line 107
with `apiRequestContext.fetch: Request context disposed` in the snapshot route
callback. The desktop case passed in the same run. The complete unchanged
owner then passed alone with
`mise run test:logged -- --name branch-claude-interactions -- bunx playwright test --config e2e/playwright.config.ts --workers=1 e2e/ClaudeInteractions.spec.ts`
(6 tests, 16.2 s). No assertion, timeout or skip changed. Evidence:
`orkestrator-test-run.Jkk5jl/branch-browser-failed-specs.log.gz` below the
host temporary directory.

## Approval-card markers validation — 2026-11-06

Branch base `ee2cc8423` (`mise run flaky:recurrence -- 0252` verdict: open).
A focused run of three interaction owners with the config's default workers
(Linux, private loopback namespace; 15 passed, 3 failed in 1.3 min) failed the
mobile case at line 137: after the reload, `Resume countdown` was not visible
within 5 s and the test hit its 30 s timeout. The change under test touched
only approval cards (human-required line, tool hint tag), not questions.

```sh
ORKESTRATOR_E2E_PORT=1497 mise run test:logged -- --name e2e-interaction-card -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/InteractionSourceLayout.spec.ts e2e/ClaudeInteractions.spec.ts e2e/InteractionPolicyChecks.spec.ts
```

The complete unchanged owner then passed alone, exit 0, in 28.9 s:

```sh
ORKESTRATOR_E2E_PORT=1497 mise run test:logged -- --name e2e-claude-interactions-rerun -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts
```

No assertion, timeout or skip changed. Evidence:
`orkestrator-test-run.OyQ3Ys/e2e-interaction-card.log.gz` below the host
temporary directory.

## Auto-pipeline spinner main merge — 2026-11-10

- **Branch and base:** `autopipeline-text-boxes-7182fc46ef5e-r1`, base `c6fdfb5a4522844b9fd5ecfce468d765084f2792`; merge parents `42e62ee3c9d85bc462b3aaa2423fae55a279d5aa` and `2ffeb36487da625e095ac6bb3daa287da184f3fe`.
- **Original command:** `ORKESTRATOR_E2E_PORT=15331 ORKESTRATOR_PUBLIC_E2E_PORT=15332 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name merge2-browser -- mise run test:browser`.
- **Workers and totals:** four Playwright workers; 1,661 passed, 152 skipped, one failed; exit 1 in 1,294.0 s. The default suite was also running on the host and passed.
- **Exact failure:** `[mobile-chromium] a paused Claude question stays paused across a reload, then resumes and answers`, `e2e/ClaudeInteractions.spec.ts:100:1`; the snapshot route callback at line 107 raised `apiRequestContext.fetch: Request context disposed`.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nyAq4V/merge2-browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15333 mise run test:logged -- --name merge2-claude-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output output/agent-testing/merge2-claude-owner` passed in 20.7 s.
- **Recurrence check:** `mise run flaky:recurrence -- 0252 --base c6fdfb5a4522844b9fd5ecfce468d765084f2792 --registry-ref origin/main` reported `open` (registry ref `7303e60108`).
- **Assessment:** the unchanged complete owner pass establishes intermittency. The in-flight snapshot/disposal race remains a hypothesis, not a proven cause. No Claude implementation, assertion, retry, timeout or skip changed. The public-site suite, not reached after the component failure, passed separately in 10.5 s.

## Effect adoption validation recurrence — 2026-11-10

Observing branch base: `04639b12b71d4326a3b8941485367aca197f4966`;
reviewed head: `c6b3ce9792c064bcac5e9eb7a287675fcbe73118`.
`mise run flaky:recurrence -- 0252` reported open.
`mise run test:logged -- --name browser -- mise run test:browser` repeated
the mobile paused-question failure at line 107: the snapshot route callback
used a disposed request context. The aggregate used eight browser workers.

The complete unchanged owner passed all six cases alone in 84.1 s:
`mise run test:logged -- --name address-claude-owner -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output=output/playwright/address-claude-owner`.
This confirms intermittence, not that the branch is unrelated. No assertion,
timeout or fixture implementation changed. Aggregate evidence and final counts
are also recorded in the Address Findings result for this validation attempt.

Aggregate outcome: terminated at the 1,800 s deadline after starting 1,584 of
1,810 cases, with 14 reported failures; no final pass/skip totals and no
public-site execution. Evidence: `/tmp/orkestrator-test-run.HLOvBh/browser.log.gz`.

## Recurrence 2026-11-11 (WebKit-scroll review)

- **Branch and base:** `webkit-scroll-fix-d230c4f38350-r1` at `18b81d327`, base
  `498b68766f5c9f357a3a86782406d1e9e0977559`. The branch does not touch the
  spec or the Claude interaction surfaces.
- **Command:** `ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name browser-rerun-3 -- mise run test:browser`
  on macOS, host load average about 23 to 27: 1697 passed, 1 failed (22.8 min).
- **Failure:** desktop-chromium, `"apiRequestContext.fetch: Target page, context or browser has been closed" while running route callback`
  at `e2e/ClaudeInteractions.spec.ts:107`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name claude-interactions-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts`;
  exit 0 (11.7 s).
- **Recurrence check:** `mise run flaky:recurrence -- 0252 --base 498b68766f5c9f357a3a86782406d1e9e0977559 --registry-ref origin/main` reported `open`.

No assertion, deadline, retry or skip was changed. The cause remains unconfirmed.

## Recurrence (2026-11-13)

On desktop this time, `a paused Claude question stays paused across a reload, then resumes and answers` (`e2e/ClaudeInteractions.spec.ts:100`) failed with `apiRequestContext.fetch: Request context disposed`. `mise run test:logged -- --name browser-rerun2 -- mise run test:browser` on beelink (Linux) at load about 12 to 30, base `17d28238c098b4443d1289df5c4ed75e7cc2802e` (`mise run flaky:recurrence` answered open), branch `remove-dead-bridge-be98778b92d1-r1` at `3d8c39043` (7571 removals), which changes none of the spec's components. The component suite reported 1,726 passed, 4 failed and 154 skipped (21.2 min). The four failures were this case and its sibling cases 1012, 0252 and 6460. The unchanged owners (`ToolGroupFold.spec.ts`, `ClaudeInteractions.spec.ts`, `CloseRetention.spec.ts`) then passed together with one worker: `mise run test:logged -- --name browser-owners-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/ClaudeInteractions.spec.ts e2e/CloseRetention.spec.ts --workers=1` (251.8 s). Evidence: `orkestrator-test-run.qZ6kD5/browser-rerun2.log.gz` under the host temporary directory.

## Recurrence — 2026-11-13 (snapshot head recovery review)

Observed on `mise run test:logged -- --name browser-rerun -- mise run test:browser` (rerun of review preparation's incomplete browser command) at `8f5280090`, branch `snapshot-head-recovery-8d306f0af39d-r1`, base `17d28238c098b4443d1289df5c4ed75e7cc2802e`. The branch changes backend transcript projection, one backend test and docs, plus a comment in `e2e/agent-testing/conditional-reads-live.spec.ts`; it changes no `apps/web` or component-spec code. The run reached case 1,780 of 1,884 before the 1,800 s group deadline (load average 37 to 44) with three failures. The three owners were then rerun together with one worker: `mise run test:logged -- --name browser-three-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts e2e/CoordinatorActions.spec.ts e2e/ToolGroupFold.spec.ts --workers=1` (82 passed, 1 failed, 1 skipped; 7.5 min). `mise run flaky:recurrence -- 0252 --base 17d28238c0` answered "open. Record the failure as a recurrence". mobile-chromium hit the 30 s test timeout in the `heldAt === undefined` poll at line 148; desktop passed. The complete unchanged owner passed in both projects in the one-worker rerun. No assertion, deadline, retry or skip was changed. The cause remains unconfirmed.
