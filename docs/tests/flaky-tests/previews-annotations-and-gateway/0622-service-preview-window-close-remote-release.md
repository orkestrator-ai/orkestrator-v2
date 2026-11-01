# Remote preview attachment still held 20 s after its window closed

- **ID:** 0622
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `windows on different backends never share previews, and switches
  release on the issuing backend` in
  `e2e/agent-testing/service-preview-electron.spec.ts`, the window-close step.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-0a835-last bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`,
  one worker, macOS 27.0 arm64 shared with other live-test worktrees (load
  average 20 to 26). The run was slow: 12 passed and 1 failed in 1.9 min,
  against about 1 min normally.
- **Failure:** after `BrowserWindow.close()` on window 2 (on the second
  backend), the second backend still reported 1 preview attachment when the
  20-second poll ended. The earlier steps of the same test (release after a
  switch to Local, and after `connect`) had passed in that run.
- **Passes:** the step passed in every other full run on 2026-10-21 (more
  than 20, including the full Electron suite), and in 4 runs right after
  (window gone 209 to 217 ms after `close()`).
- **Code path:** the `closed` handler in `main.ts` destroys the window's
  previews, then disposes the transport, which releases each attachment
  through `connectionPreviewBackend`. That keeps the last client it used, so
  the release still reaches the second backend after `connectionManager.release(scope)`
  drops the connection. Reading the code gives no reason for a 20-second hold.
- **Hypothesis:** the window closed late under load (the old step started its
  20 s poll at `close()`, not when the window was gone). Not confirmed:
  release failures were silently ignored at the time. The transport now emits
  `[Previews] Failed to release preview attachment.` on a failed backend release,
  without backend error content. The spec captures a bounded Electron output
  tail for shutdown failures; the original window-close failure did not include
  that diagnostic. Its absence from the original evidence cannot rule out a
  release failure.
- **Change:** the step now waits up to 30 s for the window to be gone, then
  polls the release for 20 s. On failure it reports how long the close took,
  how long since `close()`, and the Local backend's access counts. No timeout
  was raised for the release itself and no test was skipped.
- **Evidence:** `output/agent-testing/svc-preview-0a835-last` (failure),
  `output/agent-testing/svc-preview-0a835-close-1` to `-4` (passes, with
  `window-close` timings).


## Main merge validation, 2026-10-21

The full Electron suite failed the same two-backend scenario earlier than the
window-close step: `attachService`'s 30-second URL poll did not match `http://`
at `service-preview-electron.spec.ts:355`. The complete unchanged owning file
then passed all 14 cases (291.4 s logged), using
`ORKESTRATOR_AGENT_TEST_RUN_ID=preview-main-merge-service-preview-electron.spec.ts
mise run test:logged -- --name preview-merge-rerun-service-preview-electron.spec.ts
-- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts
service-preview-electron.spec.ts --workers=1`.
This does not reproduce or resolve the earlier window-close release symptom.
See [0623](../aggregate-validation-runs/0623-preview-main-merge-validation.md) for the original suite,
other validation limitations and artifacts. No source, assertion or timeout
changed between these Electron runs.

## Agent accounts main merge — 2026-10-24

This run failed earlier than window close: the local attachment count missed the five-second poll at line 1972. The complete unchanged service-preview owner passed all fourteen cases in 130.4 s with `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-preview-owner mise run test:logged -- --name merge-preview-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts --workers=1`. This does not reproduce the original window-close symptom.

Original command: `mise run test:logged -- --name merge-electron -- mise run test:agent:electron` (one worker): 26 passed, four failed, one skipped, one not run, 558.2 s. Evidence: `orkestrator-test-run.3IicXN/merge-electron.log.gz` below the host temporary directory. No implementation, assertion, deadline or skip changed. See [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md).

## Container state observation main merge — 2026-10-24

- **Original command:** `mise run test:logged -- --name merge-electron -- mise run test:agent:electron`, merging feature `66a9736cc` and main `d6ed0717d`; one worker alongside other validation.
- **Failure:** the same multi-backend preview scenario missed the five-second attachment-count poll at `service-preview-electron.spec.ts:1972`, immediately after attaching the second window, before the historical window-close step. Electron reported 28 passed, one skipped and three failed in 1059.8 s logged.
- **Complete unchanged owner:** `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-preview-electron-owner mise run test:logged -- --name merge-preview-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts --workers=1` passed all fourteen cases in 228.7 s logged (226.9 s Playwright execution).
- **Evidence:** `orkestrator-test-run.zGyXkd/merge-electron.log.gz` below the host temporary directory; rerun results under `output/agent-testing/merge-preview-electron-owner/electron/results.json`.
- **Assessment:** confirmed intermittent failure in the same scenario at an earlier attachment-count check; no cause was established. No implementation, assertion, timeout or skip changed.
- **Recurrence 2026-10-25:** failed once (5 s predicate timeout) in the full `test:agent:electron` run on branch `todo-0044-annotation-qualification-55474f22f1aa` at host load about 45; passed alone on rerun.
- **Service preview rollout (0042), 2026-10-25:** no recurrence in 6 runs on
  branch `todo-0042-service-preview-rollout-f64ae24ade8a`; the window was gone
  208 to 230 ms after `close()` and the remote release followed in time.

## Cause found and fixed (to-do 0042 task 11), 2026-11-01

Resolved. Run on Linux (beelink), branch `preview-flakes-d5abda30c5f5-r1` from
`main` at `93b99bfba`, with one worker while other builds ran on the host.
Electron used a private Xvfb display inside a private, loopback-only network
namespace. Durations are not reference figures.

- **Cause of the recurring failure** (2026-10-24 twice and 2026-10-25, all at
  the attachment-count poll straight after window 2 attached `svc-b`): the
  test destroys window 1's earlier tabs, then reads the Local attachment
  count as its baseline. A destroyed tab's service keeps its attachment
  through the transport's 30-second retirement lease
  (`PreviewTransportManager.release`), so window 1's `svc-b`, shown by the
  Reset site data test just before, was still counted. When opening the second
  window and attaching took longer than the lease, the lease ended between the
  baseline and the poll. The count was then one lower than the test expected:
  it waited for baseline + 1 and saw the baseline. Only slow runs (a full
  Electron suite on a loaded host) take that long.
- **Reproduction:** a temporary hook (not committed) held the unchanged test
  for 32 seconds after the baseline read, sampling the count every 2 seconds.
  The baseline was 2 (window 1's held `svc-a` and its leased `svc-b`). It
  stayed 2 until the sample at about 30 seconds, which read 1. The poll then
  failed with `Expected: 3, Received: 2`, at the same check as the
  recurrences.
- **Fix:** the test now destroys window 1's tabs before it starts the second
  backend, attaches its own `svc-a`, and then waits up to 60 seconds for that
  to be the only Local attachment before it counts. With the same 32-second
  hold the count stayed at 1 and the test passed. Unforced, it passed 3 of 3
  with the two tests before it, 2 of 2 on two pinned CPU cores, and in all
  four complete-owner runs after the fix. No timeout on a release was raised
  and nothing was skipped.
- **The original window-close failure** (2026-10-21, once) was not reproduced,
  and the lease does not explain it: closing a window disposes its transport,
  which releases every attachment at once, without a lease. The step has timed
  the close and the release separately since 2026-10-21 and has passed in
  every run since, including every run of this test listed in to-do 0042. Its
  failure message now also lists the main process's `[Previews]` lines, such
  as `Failed to release preview attachment.`, which tells a failed release
  from a slow close. Reopen this case if it fails with the window gone.

