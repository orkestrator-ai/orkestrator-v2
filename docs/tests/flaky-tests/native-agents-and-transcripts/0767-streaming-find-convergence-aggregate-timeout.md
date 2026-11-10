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


## Transcript media snapshot review repair — 2026-10-29

The exact `mise run test:browser` rerun after media snapshot fixes repeated
this case in both viewports at line 371: expected `converged`, received
`unresolved` after five seconds. Component results were 952 passed, 106 skipped
and four failed (415.8 s); the other failures were the unchanged native branch
picker. Evidence: `orkestrator-test-run.Tb46kA/review-repair-browser.log.gz`
under the host temporary directory.

The complete unchanged streaming owner passed alone (exit 0, 44.3 s):

```sh
mise run test:logged -- --name browser-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1
```

No transcript scroll implementation, assertion, deadline or skip changed.
The public-site browser suite, blocked by the full command's component-stage
failure, passed separately (exit 0, 10.8 s):

```sh
mise run test:logged -- --name review-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```


## Environment name signal review repair — 2026-10-30

The exact preparation command was rerun after repairing the sidebar fixture's
host-maintenance response and adding signal regressions:

```sh
mise run test:logged -- --name browser -- mise run test:browser
```

The nine-worker component suite reported 972 passed, 106 skipped and four failed
across 1,082 cases (455.1 seconds logged). This find-convergence case failed in
both viewports at line 371: expected `converged`, received `unresolved` after
five seconds. The other two failures were the unchanged native branch-picker
cases (`rel` instead of `release/2.0`). All signal and sidebar cases passed.
Preparation had already failed these same four unrelated cases, alongside the
now-repaired sidebar fixture failures.

The complete unchanged one-worker owner rerun reported 25 passed and one failed
(48.6 seconds logged). Desktop passed; mobile repeated the same find-convergence
failure, so this observation does not establish a complete isolated owner pass:

```sh
mise run test:logged -- --name name-signal-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/name-signal-streaming-owner
```

Artifacts are `orkestrator-test-run.ipWxnh/browser.log.gz` and
`orkestrator-test-run.hHADzF/name-signal-streaming-owner.log.gz` under the host
temporary directory. No other validation was running during the owner rerun.
The desktop difference is intermittent evidence; the persistent mobile failure
means contention alone does not explain this observation. Cause remains
unestablished. No transcript implementation, assertion, timeout or skip changed.

The public-site suite, blocked by the chained component failure, passed
separately (13.8 seconds logged):

```sh
mise run test:logged -- --name name-signal-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```


## Coordinator timers/account review — 2026-10-30

The exact browser-suite rerun (`mise run test:browser`) reported 983 passed,
106 skipped and three failed in 507.4 seconds. The desktop find-convergence
case expected `converged` and received `unresolved` after five seconds at
line 371. The other failures were the two unchanged native branch suggestions.

The complete unchanged one-worker streaming owner passed (exit 0, 47.7 seconds):

```sh
mise run test:logged -- --name browser-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1
```

Aggregate evidence is `orkestrator-test-run.WutQx0/review-repaired-browser.log.gz`
under the host temporary directory. The passing logged runner discarded its
output. No transcript implementation, assertion, deadline or skip changed.
This observation matches the earlier aggregate-only recurrence; the cause
remains unconfirmed. The public-site suite passed separately in 10.5 seconds.


## Leaf-check readiness review — 2026-10-30

Preparation repeated the desktop find-convergence failure in the nine-worker
browser aggregate (971 passed, 106 skipped, seven failed). The complete
unchanged owner passed both viewports in 72.9 s with one worker:

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-StreamingTranscript-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/pr-review-StreamingTranscript-owner
```

The exact full browser rerun also passed this case in both viewports (976
passed, 106 skipped, only the two native branch-picker cases failed). Evidence:
`orkestrator-test-run.VyCqpD/browser.log.gz` under the host temporary directory.
The host still ran other validation during the owner run; the cause remains
unconfirmed. No transcript implementation, assertion, timeout or skip changed.

## Transcript scrollbar departure after find: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).

## Environment shortcut review — 2026-11-01

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
  Chromium ran eight workers across desktop and mobile viewports; other host validation
  was active during part of the run.
- **Failure:** the mobile `scrollbar departure after find stays put when streaming reapplies highlights`
  case failed waiting for find convergence. The aggregate reported 1,038 passed,
  108 skipped and 12 failed in 685.8 s; the other failures were outside this owner.
- **Complete unchanged owner:** `NODE_ENV=test mise run test:logged -- --name transcript-scroll-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1`
  passed, exit 0, in 51.1 s.
- **Evidence:** `/tmp/orkestrator-test-run.kXXcAm/browser.log.gz`.
  No transcript implementation, assertion, deadline or skip changed. Cause remains unconfirmed.


## PR pane review — 2026-11-02

Preparation browser validation reported desktop `unresolved` instead of `converged`. The complete unchanged StreamingTranscript and VirtuosoFollow owners passed with one worker on detached `origin/main` d7cdfaa8b (`baseline-scroll-owners`, 51.5 s). The exact two desktop cases also passed three repeats each with two workers (`baseline-scroll`, 7.6 s). No cause established. Preparation evidence remains in `.orkestrator/review-artifacts/review-validation-d66c3b2c-a4b1-42da-b180-8fa7b6582c7b/` (validation-04.stdout.txt and validation-05.stderr.txt). Browser preparation reported 1146 passed, 10 failed, 117 skipped, 3 flaky. Default-suite preparation reported two failed owners; aggregate worker grants were not retained in the package. No assertion, timeout, skip or implementation was changed in these owners.

## PR pane fix round 2 — 2026-11-02

Reproduced on detached `origin/main` `d7cdfaa8b` (fresh worktree, own
`bun install --frozen-lockfile`), host load average about 21:

- `ORKESTRATOR_E2E_PORT=14874 bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts:361 e2e/VirtuosoFollow.spec.ts --project=desktop-chromium --workers=8 --repeat-each=12`:
  4 of 12 repeats of this case failed with `unresolved` instead of
  `converged` at `StreamingTranscript.spec.ts:371` (32 passed, 22.5 s).
- The same owners plus `TranscriptPaging.spec.ts`, `--workers=10 --repeat-each=6`:
  1 failed (this case), 203 passed (2.4 min).

On the PR pane branch (`eb1ec4499`) the complete unchanged
StreamingTranscript and VirtuosoFollow owners passed with one worker
(`branch-scroll-owners`, 52.3 s). The failure is therefore present on
`main` under parallel load and is not caused by that branch. No assertion,
timeout, skip or implementation changed.

### Environment terminology preparation (2026-11-02)

- **Run:** `mise run test:browser` during preparation of `rename-environment-kinds-fbee095fc40a-r1` (wording-only branch; no transcript source or spec change). The aggregate reported 9 failed, 3 flaky and 1,147 passed in 11.1 min.
- **Failure:** mobile `scrollbar departure after find stays put when streaming reapplies highlights` failed its first attempt (`toBe`) and passed on retry. It failed again on mobile in a five-owner subset run (GlobalSettings, MergedProjectList, CloseRetention, StreamingTranscript, ToolGroupFold) on the branch, and passed in the same subset on detached `origin/main` `fd679c0e2`.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=1488 mise run test:logged -- --name ek-branch-stream-4 -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts:361 e2e/ToolGroupFold.spec.ts:442 --retries=0` passed, exit 0, in 4.3 s, as did three earlier runs of the same command.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KtcBbJ/browser.log.gz` and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z0tt7k/`. Cause remains unconfirmed.

## Recurrence on the WEB-19 branch and its base, 2026-11-04

- **Commands:** `bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts -g 'scrollbar departure after find' --workers=1 --project=desktop-chromium --repeat-each=4`, once on branch `renderer-refetch-rerenders-1f6b9bb3b04b-r1` (before its rebase on `main`) and once on `a8bdce444`, on a Linux host with other work running.
- **Result:** 2 of 4 failed on the branch and 1 of 4 failed on the base commit, each with `lastOutcome` `unresolved` rather than `converged`. So it reproduces alone, without an aggregate suite, on code without the branch's change. Four runs each are too few to compare the two rates.
- **Disposition:** stays open; no assertion, timeout, skip or implementation changed.

## Legacy host-mount coverage review — 2026-11-06

- **Commit:** `5279014f9`, following reviewed commit `8686a380c`.
- **Aggregate command:** `ORKESTRATOR_E2E_PORT=51670 ORKESTRATOR_PUBLIC_E2E_PORT=51671 mise run test:logged -- --name browser -- mise run test:browser`.
  Chromium used nine workers while the default suite also ran. Results were
  1,516 passed, 135 skipped and three failed in 19.5 minutes.
- **Failure:** mobile `scrollbar departure after find stays put when streaming reapplies highlights`
  expected `converged` but received `unresolved` at line 371 after the 5,000 ms
  polling deadline. The two other failures were in `TabLaunchOverride.spec.ts`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=51670 mise run test:logged -- --name review-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/review-streaming-owner`
  passed with exit 0 in 81.9 seconds. The logged runner removed passing output;
  isolated case counts are not inferred.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.GC5d6F/browser.log.gz`;
  original failure trace and context remain under
  `output/playwright/test-results/StreamingTranscript-scroll-bd9d1-eaming-reapplies-highlights-mobile-chromium/`.
- **Disposition:** recurrence of the open aggregate-convergence case. The cause
  remains unconfirmed. No transcript source, assertion, timeout or skip changed.

## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, the nine-worker command
`mise run test:logged -- --name repair-browser -- mise run test:browser`
reported 1,513 passed, 135 skipped and six failed (1,654 cases; 1,225.3 s).
Evidence: host temporary artifact
`orkestrator-test-run.C3ovaT/repair-browser.log.gz`. The browser implementation
and this test are unchanged by the bridge-authority branch.

The mobile find case again reported `unresolved` instead of `converged` at
line 371. The complete unchanged owner passed alone (exit 0, 84.2 s):

```sh
mise run test:logged -- --name isolate-streaming -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/agent-testing/address-browser-reruns/streaming
```

The isolated pass confirms intermittence; the cause remains unconfirmed. Status
stays open. No assertion, timeout or skip changed.

## Auto-pipeline address validation — 2026-11-10

Observed on `autopipeline-text-boxes-7182fc46ef5e-r1` at `944b37af1`, based on
`8d0ae2764e0a5875144d15ee0f526608e6c1c1e8`. The reviewed commit `02f72782c` remains in history.

- **Original command:** `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`.
- **Aggregate result:** incomplete at the 1,800 s runner deadline; 69 named failures,
  last progress 1,194/1,814, with no final pass/skip totals. Public-site tests were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15212 mise run test:logged -- --name address-streamingtranscript-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-streamingtranscript-alone e2e/StreamingTranscript.spec.ts`; exit 0, exit 0, one worker and both viewport projects.
- **Recurrence check:** `mise run flaky:recurrence -- 0767 --base 8d0ae2764e0a5875144d15ee0f526608e6c1c1e8 --registry-ref origin/main` reported `open`.

| Project | Location | Exact test |
| --- | --- | --- |
| mobile-chromium | `e2e/StreamingTranscript.spec.ts:361` | scrollbar departure after find stays put when streaming reapplies highlights |

The owning spec and its implementation were unchanged. No assertion, deadline,
retry or skip was changed. This establishes intermittency, not its cause.
The full run and remaining undetermined failures are recorded in
[9920](../aggregate-validation-runs/9920-auto-pipeline-fix-browser-owners.md).
