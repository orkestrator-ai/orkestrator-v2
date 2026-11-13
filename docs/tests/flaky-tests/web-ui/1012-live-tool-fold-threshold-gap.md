# a live group crossing the fold threshold folds into its line with no-preference motion

- **ID:** 1012
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `a live group crossing the fold threshold folds into its line with no-preference motion`
- **File:** `e2e/ToolGroupFold.spec.ts:79`
- **Original command:** `mise run test:browser`, nine browser workers.
- **Failure:** Mobile fold-gap maximum was 80 px instead of at most 2 px at line 147.
- **Suite counts:** 770 passed, three failed, 103 skipped across 876 component cases.
- **Isolated rerun:** `mise run test:logged -- --name browser-tool-fold-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1` passed the complete unchanged owning file (77.9 s).
- **Evidence:** `orkestrator-test-run.pU67Df` below the host temporary directory.
- **Hypothesis:** The post-fold geometry sample can observe an intermediate layout under parallel browser load; the unchanged full owner passes with one worker. Not confirmed; no assertion, timeout or skip changed.

## Recurrence during search review fixes, 2026-10-27

The nine-worker component run reproduced the mobile threshold gap: 57 px
against a 2 px limit. The complete unchanged ToolGroupFold owner then passed
both viewports in a one-worker, four-owner rerun (the combined command failed
in other owners). Aggregate: 790 passed, 103 skipped, five failed; owner batch:
83 passed, 20 skipped, five failed. Exact commands and artifacts are recorded
in [1126](../aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md#review-fix-validation-2026-10-27).
Status remains open; no assertion, timeout, or skip changed.

## Rewind review validation, 2026-10-28

Preparation for the pipeline rewind follow-ups reproduced the mobile gap at
57 px in `mise run test:browser`. The complete unchanged ToolGroupFold owner
passed all 38 cases across both viewports with one worker in a combined
42-case run with AgentLaunchDialog (162.6 s). The two failures in that run
were the previously established native branch suggestion failure (`rel`
instead of `release/2.0`), also recorded in aggregate case 0958.

Command: `ORKESTRATOR_E2E_PORT=24982 mise run test:logged -- --name recorded-browser-failures -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/ToolGroupFold.spec.ts --workers=1`.
Evidence: `orkestrator-test-run.AJChkk/recorded-browser-failures.log.gz` under
the host temporary directory. No assertion, timeout or skip changed.

## Coordinator PR-tab validation, 2026-10-28

The browser suite on branch `pr-review-process-8b9b35a14ee2-r1` (backend
coordinator prompts and PR commands; no web or fixture code) had a
ToolGroupFold failure. With nine workers and five repetitions at load average
40–86, the merged branch repeated the mobile gap at 57 px, and detached
`origin/main` `4588fa511` repeated it twice at 57 px in ten repetitions (with
0793's line-153 case). Command:
`ORKESTRATOR_E2E_PORT=<free port> bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --repeat-each=10 --workers=9`.
Evidence: `.orkestrator/fix-validation/r2/baseline-toolgroupfold-2.log` and
`branch-toolgroupfold.log` in that checkout. No assertion, timeout or skip
changed.


## Project icon review validation — 2026-10-29

The mobile live-fold case failed in preparation at 57 px against the 2 px limit, then passed in the exact complete browser rerun.
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

## Pipeline validation-history review, 2026-10-30

Preparation's `mise run test:browser` again reported a 57 px mobile fold gap
against a 2 px limit (973 passed, 106 skipped, three failed overall). Evidence:
`.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-05.stdout.txt`.
The complete unchanged owner passed all 38 cases across both viewports, exit 0
in 100.3 s:

```sh
mise run test:logged -- --name recorded-tool-fold -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1
```

Passing output was removed; the summary remains in
`orkestrator-test-run.YX20cU` below the host temporary directory. No folding
implementation, assertion, timeout or skip changed; the cause is unconfirmed.

## Leaf-check readiness review — 2026-10-30

Preparation repeated the desktop no-preference fold-gap failure at line 147 in
the nine-worker component browser aggregate (971 passed, 106 skipped, seven
failed). The complete unchanged ToolGroupFold owner passed with one worker in
98.0 s:

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-ToolGroupFold-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/pr-review-ToolGroupFold-owner
```

The exact full browser rerun passed every group-fold case (976 passed, 106
skipped, only the two native branch-picker cases failed), with evidence in
`orkestrator-test-run.VyCqpD/browser.log.gz` under the host temporary directory.
The host still ran other validation during the owner run; the cause remains
unconfirmed. No group implementation, assertion, timeout or skip changed.


## Validation worker review — 2026-10-31

The four-worker browser aggregate passed the fold-threshold cases, but the
complete unchanged one-worker owner subsequently failed mobile with a 9 pixel
gap at line 147 and desktop with a 7 pixel gap at line 122 (both expect at most
2). The owner reported 35 passed and three failed in 166.2 seconds; the third
failure was a mobile live-group-below-reader `scrollend` timeout. Both
waiting-group cases passed (0747). This does not establish a root cause or a
fix. The exact command, concurrent isolated-profile context and retained
artifacts are recorded in the Validation worker review entry in
[0747](0747-tool-group-overflow-follow.md). No assertions or timeouts changed.

## History-loading main merge — 2026-10-31

History-loading main merge on 2026-10-31 repeated fold gaps of 9 px mobile and 15 px desktop; the complete unchanged folding owner passed in the one-worker five-owner rerun (1600).

Exact commands, eight-worker aggregate counts, sequential one-worker results,
failure details and retained evidence are in
[1600](../aggregate-validation-runs/1600-history-loading-main-merge-validation.md).
No owning implementation, assertion, timeout or skip changed between runs.


## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, the nine-worker command
`mise run test:logged -- --name repair-browser -- mise run test:browser`
reported 1,513 passed, 135 skipped and six failed (1,654 cases; 1,225.3 s).
Evidence: host temporary artifact
`orkestrator-test-run.C3ovaT/repair-browser.log.gz`. The browser implementation
and this test are unchanged by the bridge-authority branch.

The mobile no-preference case repeated a 57 px maximum gap against the 2 px
limit at line 147. The complete unchanged owner passed alone (exit 0, 135.0 s):

```sh
mise run test:logged -- --name isolate-fold -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/agent-testing/address-browser-reruns/fold
```

This confirms intermittence; the cause remains unconfirmed. Status stays open.
No assertion, timeout or skip changed.

## Mixed-version CI repair review — 2026-11-10

At `df39c7db3` (base `53340356c`), review preparation's `mise run test:browser`
reported 1,665 passed, 152 skipped and one failed. The desktop no-preference
case had a maximum gap of 8 px at line 122, then 9 px at line 147 on retry,
against the 2 px limit. The branch changes no renderer code, and neither the
spec nor the tool-group implementation changed.

The complete unchanged owner, rerun alone with one worker while a full
`mise run test:full` loaded the host, failed again: gaps of 46 px and 17 px
(desktop and mobile), plus two `scrollend` timeouts. Rerun alone on a quiet
host at `645183531`, it passed (exit 0, 102.6 s):

```sh
NODE_ENV= mise run test:logged -- --name toolgroupfold-alone-quiet -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1
```

This points again to sensitivity to host load. The cause remains unconfirmed,
and the status stays open. No assertion, timeout or skip changed.

## Releases page review repairs — 2026-11-10

Observed 2026-11-10 on `releases-page-b2c7d73cdbc4-r1`, base commit
`53340356c51e6bdb6f86cb6d806575218bbbc6bd`
(`mise run flaky:recurrence -- 1012 --base 53340356c5`: open, record the
recurrence). The branch changes only `apps/web-public` and docs; the review
package's failure triage marked this test `undetermined` with reasons
`known-flaky` and `not-import-traceable`.

Review preparation's `mise run test:browser` (exit 1, 1,219.1 s; 1,664
passed, 152 skipped) failed this case on mobile and desktop with gaps above
2 px. Two complete one-worker owner reruns then also failed it:

```sh
mise run test:logged -- --name toolgroupfold-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1
```

- First rerun, overlapping a `mise run test` run: 31 passed, 7 failed
  (5.9 min). This case failed on mobile (10 px) and desktop (95 px); five
  line-153 `preserves their place` cases timed out or missed their offset.
- Second rerun, after `mise run test` finished: 35 passed, 3 failed
  (3.6 min). This case failed with 5 px on mobile and 9 px on desktop; the
  mobile line-153 `growing below ... with reduce motion` case timed out.

The host load average was about 41 on 16 cores (unrelated agent work) during
both reruns, so the one-worker owner did not get the idle host the earlier
passing reruns had. The cause remains unconfirmed. Status stays open. No
assertion, timeout or skip changed.

## Action-search review repair — 2026-11-10

Preparation for the coordinator action-search branch (`action-search-modal-1162dc5c0a2a-r1`, base `53340356c`, validated at `300105a39`) ran `mise run test:logged -- --name browser -- mise run test:browser`: 5 failed, 5 flaky, 152 skipped, 1656 passed. The branch changes only the coordinator Actions panel, which renders for coordinator tabs; neither spec opens one. Evidence: `validation-11.stdout.txt` under `.orkestrator/review-artifacts/review-validation-985e2298-c3a5-42bd-bd66-83c90557e178/`. Both mobile-chromium and desktop-chromium failed `expect(received).toBeLessThanOrEqual(2)` (desktop received 8, then 51 on retry).

The complete unchanged ToolGroupFold and TranscriptPaging owners then passed together with one worker (exit 0, 296.8 s):

```sh
mise run test:logged -- --name browser-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.

## Transcript history efficiency review repair — 2026-11-11

Branch `transcript-history-efficiency-60750035e24d-r1` (base `498b68766f5c`, validated at `b0dc43135`): this case failed on mobile in the preparation run (9 px, then 141 px on retry) and on both projects in the completed rerun of `mise run test:logged -- --name browser -- mise run test:browser` (11 failed, 1,681 passed; full list in [0382](0382-component-browser-parallel-load.md)). The branch changes `TranscriptScrollController.holdPlaceAcrossReflow`, which this owner runs. The complete ToolGroupFold, TranscriptPaging and MailTiles owners then passed together with one worker, with that change in place (exit 0, 337.3 s). `mise run flaky:recurrence -- 1012 --base 498b68766f5c` reported a recurrence. Status stays open. No assertion, timeout or skip changed.

## Merge button review — 2026-11-11

Preparation for the merge button branch (`merge-button-confusion-7ba4930d15d6-r1`, base `465c473d9`, validated at `ab8580dda`) ran `mise run test:logged -- --name browser -- mise run test:browser`: 4 failed, 2 flaky, 152 skipped, 1694 passed (26.7 m). The branch changes the action bar's merge controls, the ticket view's PR bar and their tests; neither spec renders them. `mise run flaky:recurrence -- 1012 --base 465c473d9` answered "open. Record the failure as a recurrence". Evidence: `validation-05.stderr.txt` under `.orkestrator/review-artifacts/review-validation-085f2243-54bc-4625-8ead-8f255e326766/`. Both mobile-chromium and desktop-chromium failed `expect(received).toBeLessThanOrEqual(2)` (mobile received 95, desktop 8), on the first attempt and the retry.

The complete unchanged ToolGroupFold and TranscriptPaging owners then passed together with one worker (exit 0, 289.0 s):

```sh
mise run test:logged -- --name transcript-browser-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.

## Client-outage restart review — 2026-11-11

Preparation for `beelink2-restart-failure-b5978072af7f-r1` (base `963ffa6ab`, validated at `e7e25352f`) ran `mise run test:logged -- --name browser -- mise run test:browser`: 2 failed, 153 skipped, 1719 passed (23.3 m). The branch changes the To pipeline toolbar button and its test; this spec does not render it. `mise run flaky:recurrence -- 1012 --base 963ffa6ab` answered "open. Record the failure as a recurrence". Evidence: `validation-05.stderr.txt` under `.orkestrator/review-artifacts/review-validation-63babffd-7be4-45f4-9eba-00d573593669/`. Both projects failed `expect(received).toBeLessThanOrEqual(2)` at line 122 (received 9 and 15).

The case then passed alone with one worker (exit 0, 16.2 s):

```sh
mise run test:logged -- --name toolgroupfold-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts -g "crossing the fold threshold" --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (Effect adoption follow-ups, second review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `f799aaa14`, base `14df96544` (`mise run flaky:recurrence -- 1012 --base 14df96544` answered "open. Record the failure as a recurrence"). The branch changes backend read cancellation, one desktop IPC test and docs; it changes no `apps/web` or `e2e` code. `mise run test:logged -- --name browser -- mise run test:browser`: 6 failed, 153 skipped, 1709 passed (21.9 m), all six in ToolGroupFold and TranscriptPaging (flakes 1012, 0483, 1602). Both mobile-chromium and desktop-chromium failed `expect(received).toBeLessThanOrEqual(2)` (mobile received 8, desktop 15). The complete unchanged owners then passed together with one worker: `mise run test:logged -- --name browser-fold-paging-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1` (exit 0, 283.0 s). Status stays open; no assertion, timeout or skip changed.

A second browser run on the same branch (at `487e2aa4e`: 9 failed, 1706 passed) failed the same cases again; the two owners again passed together with one worker (295.5 s). See 0382 for that run.

## WebKit macOS input review repair — 2026-11-13

On `webkit-macos-input-9c0ac85051e8-r1` (base `17d28238c`, repair at `3d3370c35`), the rerun of the recorded `test:browser` command (`ORKESTRATOR_E2E_PORT=1532 mise run test:logged -- --name browser-rerun -- mise run test:browser`, since another worktree's fixture server held port 1422) failed only the mobile case, at line 195: `expect(received).toBeLessThanOrEqual(2)`, received 57 (2 failed, 154 skipped, 1728 passed, 27.7 m; host load average about 10). `mise run flaky:recurrence 1012 --base 17d28238c` answered "open. Record the failure as a recurrence". The branch changes the transcript scroll controller's upward-input hold, which is armed only by upward reader input and cleared by any navigation; this case drives no reader input. The complete unchanged owner then passed alone with one worker (exit 0, 100.3 s):

```sh
ORKESTRATOR_E2E_PORT=1532 mise run test:logged -- --name tool-group-fold-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.
