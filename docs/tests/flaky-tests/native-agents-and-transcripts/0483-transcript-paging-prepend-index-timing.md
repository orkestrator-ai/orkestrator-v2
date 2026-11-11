# Transcript paging observes the previous row index after prepend

- **ID:** 0483
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `native: paging before prose holds the original tool position` (mobile Chromium)
- **File:** `e2e/TranscriptPaging.spec.ts:57`
- **Original command:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-component-browser-two-workers -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
- **Workers:** two Playwright workers alongside the non-iOS aggregate, isolated browser validation and other worktrees.
- **Failure:** the tool's row index was still `1`, expected greater than the original `1`, after the offset-preservation poll passed.
- **Suite counts:** 357 passed, 80 skipped and three failed across 440 cases (957.8 s logged). The other owners were DesignCanvas and DiffViewerMobile (0382).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-transcript-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/playwright/merge-browser-owners/TranscriptPaging` passed all eight unchanged cases, exit 0, in 63.9 s.
- **Evidence:** `orkestrator-test-run.5S9NY7/merge-component-browser-two-workers.log.gz` below the host temporary directory; Playwright failure under `output/playwright/test-results/TranscriptPaging-native-pa-48048--the-original-tool-position-mobile-chromium/`.
- **Assessment:** confirmed intermittent observation. Prepend/render timing remains a hypothesis; no source, assertion, timeout or skip changed.

## Claude revision-token third main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name revtok-main3-browser -- mise run test:browser`, with the default component-browser workers alongside the repository aggregate and Electron checks.
- **Failure:** the same mobile native paging case failed its offset-preservation poll at line 70: 244.5 px rather than less than 3 px within 5000 ms. This differs from the earlier row-index assertion in this case history. The component suite reported 398 passed, 81 skipped and one failed across 480 cases (3.5 minutes).
- **Unchanged whole owner:** `mise run test:logged -- --name revtok-main3-transcript-paging-owner-correct -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1` passed all eight cases in 44.9 s. An earlier command used a nonexistent root config and exited before discovering any tests; it is not validation evidence.
- **Evidence:** `orkestrator-test-run.9O0EhD/revtok-main3-browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent occurrence in the same scenario, with a different assertion; rendering timing remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Recurring-work qualification main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine Playwright workers alongside the repository aggregate, Electron checks and Docker image build. Pre-merge HEAD was `61866a15b208019ee787038202be0e3381a42343`; merged main was `3b469e885`.
- **Failure:** desktop Chromium `native: paging before prose holds the original tool position` failed its offset-preservation poll at line 70: 244.5 px, expected less than 3 px within 5000 ms. Component coverage reported 410 passed, 85 skipped and three failed across 498 cases (253.8 s logged). The other two failures were native branch-suggestion selection in `AgentLaunchDialog.spec.ts`.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-transcript-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1` passed all eight cases, exit 0 (43.7 s logged).
- **Evidence:** `orkestrator-test-run.S5weqt/merge-browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent offset-preservation failure. The owner and implementation were unchanged by this merge; no assertion, deadline or skip was changed.


## Session lifecycle review recurrence — 2026-10-23

The desktop native paging case saw prepend index 1 instead of an index greater than 1 during the nine-worker component suite. The complete unchanged owner passed separately with one worker in 47.2 seconds. Exact aggregate counts, owner command, and evidence are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#session-lifecycle-review-validation--2026-10-23). No assertion, timeout, or skip changed.

## Todo 0090 folded-group paging tests — 2026-10-25

- **Original command:** `ORKESTRATOR_E2E_PORT=14390 mise run test:logged -- --name transcript-paging-owner-4w -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=4`, on branch `todo-0090-held-place-drift` (this owner file with four new folded-group test scenarios across two projects: eight added project cases, 30 cases in all), on arktech-mini.
- **Failures:** two, both this scenario. Desktop native kept prepend index `1` (expected greater than `1`); mobile native's scrollTop stayed `0` (expected greater than 500). An earlier four-worker run of the same file that day failed mobile native once as well. The new folded-group cases passed in every run.
- **Suite counts:** 28 passed, 2 failed (43.6 s).
- **Owner reruns:** `-g "paging before prose" --repeat-each 3 --workers 4` passed 12 of 12 (26.4 s); the whole owner with `--workers=1` passed all 30 cases (111.0 s logged).
- **Assessment:** confirmed intermittent recurrence under parallel load. The fixture's default (unpaged) history is unchanged by this branch: the new `paged`, `stops` and `prompt` options default off. The index assertion failing while the offset held fits a page that never landed, as when the native tab's background poll retires a page in flight (transcript-scroll.md, Known limitations). That remains a hypothesis. No assertion, timeout or skip changed.


## Hidden-resume review recurrence — 2026-10-26

- **Failure:** Desktop `native: paging before prose holds the original tool position` retained row index 1 instead of greater than 1.
- **Complete unchanged owner:** `mise run test:logged -- --name paging-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/playwright/resume-paging-owner` passed (96.6 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.


## History-loading main merge — 2026-10-31

History-loading main merge on 2026-10-31 repeated index 1 on both viewports and the desktop byte-bounded variant; the complete unchanged paging owner passed in the one-worker five-owner rerun (1600).

Exact commands, eight-worker aggregate counts, sequential one-worker results,
failure details and retained evidence are in
[1600](../aggregate-validation-runs/1600-history-loading-main-merge-validation.md).
No owning implementation, assertion, timeout or skip changed between runs.


## Renderer efficiency review — 2026-11-02

Preparation at `9ad6e88dc` reported desktop `native: paging before prose holds the original tool position` retaining index 1 rather than increasing (browser: 1080 passed, 7 failed, 116 skipped, 1 flaky, 1262.4 s). The original command was `mise run test:logged -- --name browser -- mise run test:browser`.

On detached `origin/main` at `38d55ee14`, with separately installed frozen dependencies, all 19 desktop paging cases passed in the three-owner, two-worker comparison (`CloseRetention.spec.ts TranscriptPaging.spec.ts VirtuosoFollow.spec.ts`; 35 passed, 6 unrelated failures overall, 338.4 s). Repeating the unchanged paging owner three times with two workers reproduced the same index-1 assertion, plus the byte-bounded and same-minute variants and a missing folded-group button (53 passed, 4 failed, 305.1 s). This establishes recurrence without the renderer efficiency changes; no assertion, skip or timeout was changed.

Commands used `ORKESTRATOR_E2E_PORT=1437 mise run test:logged -- --name baseline-browser-failures -- bunx playwright test CloseRetention.spec.ts TranscriptPaging.spec.ts VirtuosoFollow.spec.ts --config=e2e/playwright.config.ts --project=desktop-chromium --workers=2`, then `ORKESTRATOR_E2E_PORT=1437 mise run test:logged -- --name baseline-paging-repeat -- bunx playwright test TranscriptPaging.spec.ts --config=e2e/playwright.config.ts --project=desktop-chromium --workers=2 --repeat-each=3`.

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BoEPrl/baseline-browser-failures.log.gz` and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ULKrgc/baseline-paging-repeat.log.gz`. Root cause remains unconfirmed.

## Transcript restoration repair — 2026-11-06

`ORKESTRATOR_E2E_PORT=14860 mise run test:logged -- --name repair-transcript-browser -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-transcript-browser e2e/TranscriptPaging.spec.ts e2e/VirtuosoFollow.spec.ts`
reported the desktop byte-bounded variant at line 102: the prepended row index
remained 1 instead of becoming greater than 1. The combined run had 37 passes,
three failures and two skips in 80.8 s. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.7sBWhR/repair-transcript-browser.log.gz`.

The complete unchanged paging owner passed alone, exit 0, in 210.1 s:
`ORKESTRATOR_E2E_PORT=14861 mise run test:logged -- --name repair-paging-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-paging-alone e2e/TranscriptPaging.spec.ts --workers=1`.
Passing output was deleted by the logged runner. No paging assertion, timeout
or skip changed; no cause is established.

## Transcript list re-render rework — 2026-11-06

On the `transcript-list-rerender` branch (to-do 6280 plus the tool-group
follow fix for 0747),
`mise run test:logged -- --name paging22 -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts:22 --repeat-each=10 --workers=3 --retries=0`
failed 8 of 100: six kept prepend index 1 at `:102`, one byte-bounded case
kept a load button at `:85`, and one same-minute case failed the offset check
at `:119`. That is close to the 4 of 57 rate recorded above on detached
`origin/main`. The earlier three-spec run (`TranscriptListRenders`,
`TranscriptPaging`, `StreamingTranscript`, three workers) failed only the
mobile byte-bounded index case, 79 passed. No assertion, skip or timeout
changed; root cause remains unconfirmed.

## Renderer error ring review — 2026-11-11

Branch `renderer-error-ring-e3a48fce2746-r1` (to-dos 6300 and 6301), base
`498b68766`; `mise run flaky:recurrence -- 0483 --base 498b68766` reported `open`.
The owning spec and its implementation are unchanged on the branch.

In the one-worker two-owner rerun

```sh
NODE_ENV= ORKESTRATOR_E2E_PORT=14722 mise run test:logged -- --name browser-flake-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --workers=1 e2e/TranscriptPaging.spec.ts e2e/DataSavingGateway.spec.ts
```

the mobile `native: paging before prose in a byte-bounded view holds the
original tool position` case kept prepend index 1 at
`e2e/TranscriptPaging.spec.ts:138` (expected greater than 1); 40 passed, one
skipped, one failed in 6.3 m. It was not among the failures of the preparation's
nine-worker browser suite, which passed it. Root cause remains unconfirmed.
Status stays open. No assertion, timeout or skip changed.

## Transcript history efficiency review repair — 2026-11-11

Branch `transcript-history-efficiency-60750035e24d-r1` (base `498b68766f5c`, validated at `b0dc43135`): this case failed in the completed rerun of `mise run test:logged -- --name browser -- mise run test:browser` (11 failed, 1,681 passed; full list in [0382](../web-ui/0382-component-browser-parallel-load.md)). The branch changes `TranscriptScrollController.holdPlaceAcrossReflow`, which this owner runs. The complete ToolGroupFold, TranscriptPaging and MailTiles owners then passed together with one worker, with that change in place (exit 0, 337.3 s). `mise run flaky:recurrence -- 0483 --base 498b68766f5c` reported a recurrence. Status stays open. No assertion, timeout or skip changed.

## First-find navigation fix — 2026-11-11

On the `document-find-bug-3a3f9ad04ef2-r1` branch (to-do 6620, base
`498b68766`), with a find match box that now carries its row
(`transcript-scroll-controller.ts`),
`ORKESTRATOR_E2E_PORT=14937 mise run test:logged -- --name scroll-e2e -- bunx playwright test --config e2e/playwright.config.ts VirtuosoFollow.spec.ts TranscriptPaging.spec.ts TranscriptHold.spec.ts FirstFindLands.spec.ts TranscriptListRenders.spec.ts StaticHtmlTranscript.spec.ts NativeFollowStability.spec.ts`
(default workers) failed one of 128 starts: mobile `native: paging before prose
in a byte-bounded view holds the original tool position` kept prepend index 1
at `:138` (107 passed, 20 skipped, 2.9 m). The case does not open find, so the
changed path is not reached. Rerun alone,
`ORKESTRATOR_E2E_PORT=14937 mise run test:logged -- --name paging-rerun -- bunx playwright test --config e2e/playwright.config.ts TranscriptPaging.spec.ts:42 --project mobile-chromium --repeat-each 5`
passed all 25 starts in 70.6 s. `mise run flaky:recurrence -- 0483 --base HEAD`
reported the case open. No assertion, skip or timeout changed; root cause
remains unconfirmed.


## Find review repair — 2026-11-11

On `document-find-bug-3a3f9ad04ef2-r1` at `bdc583ce4` (base `498b68766`), a
targeted ten-spec browser run beside another checkout's browser suite (load
average about 30 to 36, default workers) failed mobile `paging before prose in a byte-bounded view` and mobile `a same-minute page growing row zero` (prepend index at `:138`). The complete unchanged
owner then passed alone with two workers. `mise run flaky:recurrence -- <case>
--base 498b68766` reported the case open. Details and commands:
[9954](../aggregate-validation-runs/9954-find-review-targeted-browser-run-under-host-load.md).
No assertion, skip or timeout changed; root cause remains unconfirmed.

## Second Find review repair — 2026-11-11

On `document-find-bug-3a3f9ad04ef2-r1` at `fa5a841ca` (base `498b68766`),
the recorded `mise run test:browser` rerun (default workers, stopped at its
30-minute group deadline) failed mobile `native: paging before prose holds the
original tool position` with the prepend index at 1 (`:138`). The complete
unchanged owner passed alone with two workers in 133.0 s. `mise run
flaky:recurrence -- 0483 --base 498b68766` reported the case open. Details:
[9954](../aggregate-validation-runs/9954-find-review-targeted-browser-run-under-host-load.md).
No assertion, skip or timeout changed; root cause remains unconfirmed.

## Launch-override marker review repair — 2026-11-11

On `launch-override-marker-043a84998c41-r1` (base `498b68766`), the desktop
case failed in a multi-worker run of the desktop specs the deadline-killed
component suite had not reached (686 passed, 30 skipped, two failed):
`expect(received).toBeGreaterThan(1)` received 1. The complete unchanged owner
passed with one worker (with `DataSavingGateway.spec.ts`, 129.4 s).
`flaky:recurrence 0483` reported `open`. The branch does not change the
transcript. Full run: [9953](../aggregate-validation-runs/9953-launch-override-marker-browser-owners.md).

## Merge button review — 2026-11-11

Preparation for the merge button branch (`merge-button-confusion-7ba4930d15d6-r1`, base `465c473d9`, validated at `ab8580dda`) ran `mise run test:logged -- --name browser -- mise run test:browser`: 4 failed, 2 flaky, 152 skipped, 1694 passed (26.7 m). The branch changes the action bar's merge controls, the ticket view's PR bar and their tests; neither spec renders them. `mise run flaky:recurrence -- 0483 --base 465c473d9` answered "open. Record the failure as a recurrence". Evidence: `validation-05.stderr.txt` under `.orkestrator/review-artifacts/review-validation-085f2243-54bc-4625-8ead-8f255e326766/`. mobile-chromium failed `expect(received).toBeGreaterThan(1)` (received 1) on the first attempt and the retry.

The complete unchanged ToolGroupFold and TranscriptPaging owners then passed together with one worker (exit 0, 289.0 s):

```sh
mise run test:logged -- --name transcript-browser-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.
