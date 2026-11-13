# Live tool group missing from overscan during parallel browser validation

- **ID:** 0793
- **Status:** open
- **Date:** 2026-10-25
- **Owner:** `e2e/ToolGroupFold.spec.ts:153`, `a live group growing above a released reader preserves their place with reduce motion`.

The mobile case failed its five-second overscan poll at line 195 in `ORKESTRATOR_E2E_PORT=1447 mise run test:logged -- --name browser-suite-isolated-port -- mise run test:browser` with nine workers during repository validation. The poll scrolls upward until the live-fold group is mounted; it returned false throughout the deadline. No shortcut behavior is involved in this fixture.

The complete unchanged owner passed sequentially with one worker in `ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name browser-failed-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/browser-failed-owners` (168.5 seconds logged for both owning files). No implementation, assertion, timeout or skip changed between these runs. This establishes intermittence; the cause remains unconfirmed.

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rMjVIf/browser-suite-isolated-port.log.gz` and `output/playwright/test-results/ToolGroupFold-a-live-group-480bf-ir-place-with-reduce-motion-mobile-chromium/`. The passing rerun used `output/playwright/browser-failed-owners/`.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation, with nine workers. This is the `above` variant of the test that replaced [9883](9883-tool-fold-history-anchor.md).
- **Next step:** the poll scrolls with mouse-wheel steps of 250 px and 100 ms waits. On recurrence, check whether wheel input was dropped or coalesced; setting `scrollTop` directly would remove that dependency.

## Growing live tool group: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).

## Transcript history efficiency review repair — 2026-11-11

Branch `transcript-history-efficiency-60750035e24d-r1` (base `498b68766f5c`, validated at `b0dc43135`): this case failed in the completed rerun of `mise run test:logged -- --name browser -- mise run test:browser` (11 failed, 1,681 passed; full list in [0382](0382-component-browser-parallel-load.md)). The branch changes `TranscriptScrollController.holdPlaceAcrossReflow`, which this owner runs. The complete ToolGroupFold, TranscriptPaging and MailTiles owners then passed together with one worker, with that change in place (exit 0, 337.3 s). `mise run flaky:recurrence -- 0793 --base 498b68766f5c` reported a recurrence. Status stays open. No assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (Effect adoption follow-ups, second review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `487e2aa4e`, base `14df96544` (`mise run flaky:recurrence -- 0793 --base 14df96544` answered "open. Record the failure as a recurrence"). The branch changes no `apps/web` or `e2e` code. A second `mise run test:logged -- --name browser -- mise run test:browser` on that branch: 9 failed, 153 skipped, 1706 passed (21.3 m), all in ToolGroupFold and TranscriptPaging (flakes 1012, 0483, 1602, 0793 and this case). Both desktop-chromium `a live group growing above a released reader preserves their place` cases (line 153, no-preference and reduce motion) hit the 30 s test timeout in `locator.evaluate`. The complete unchanged owners then passed together with one worker: `mise run test:logged -- --name browser-fold-paging-alone-2 -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1` passed (exit 0, 295.5 s). Status stays open; no assertion, timeout or skip changed.

## Resolution (2026-11-11)

Base `51456e887` (`main`), branch `fix-flaky-tests-400972eda2c6-r1`. The
recurrence check (`mise run flaky:recurrence`) reported the case open.

- **Root cause:** two test-side races in `e2e/ToolGroupFold.spec.ts:153`,
  both in the steps that bring the reader into place.
  1. *The 30 s hang in `locator.evaluate` (recorded 2026-11-11).* The
     `scrollend` listener was installed by a `scroller.evaluate` that was
     started but not awaited before `page.mouse.wheel`. The locator first
     resolves the scroller in a round trip, so on a loaded host the wheel's
     short scroll could end before the listener existed; the promise then
     never resolved and the test hit its 30 s timeout.
  2. *The overscan poll returning false for 5 s (recorded 2026-10-25).* The
     group sits 20 rows above the end, and the poll moved the reader with one
     250 px wheel per `expect.poll` iteration plus 100 ms waits. Under the
     poll's back-off (100, 250, 500, 1,000 ms) a 5 s budget allows about seven
     iterations; on mobile each wheel advanced the reader about 250 px while
     Virtuoso's compensation for newly measured rows absorbed the rest, and a
     slow page completes fewer iterations, so the group never reached
     overscan in time.
- **Fix:** `e2e/ToolGroupFold.spec.ts`. The scrollend promise is gone: the
  test waits for the wheel's movement (`bottomGap > 100`) and then for
  `scrollQuiet`, five consecutive rendered frames without a scroll event.
  The group is brought into overscan by an in-page loop that lowers
  `scrollTop` by 250 px and waits two rendered frames until the list mounts
  it (bounded by reaching the top, which throws), so the distance covered no
  longer depends on wall-clock time. The 8-frame wait before the wheel is
  now `scrollQuiet` (the first bottom fill's corrections cut the wheel
  short when they landed during it). The two existing
  `page.waitForTimeout(400)` calls are replaced by `readerSettled`:
  `scrollQuiet`, then the same 400 ms as an in-page timer. That delay stands
  for the transcript's own idle timers armed by its last scroll (the 250 ms
  input window and the 150 ms reading-anchor capture that the fold's hold
  restores); a page timer armed after the last scroll for at least as long
  runs after them because page timers run in expiry order, which the
  runner-side wait could not guarantee. No delay was lengthened and no
  assertion changed.
- **Reproduced:** yes. With Chromium's CPU throttled 10x through CDP
  (`Emulation.setCPUThrottlingRate`) on a scratch copy of the spec, the
  unchanged test failed 6 of 32 `above` runs (8 repeats, 6 workers), each
  hung awaiting `scrollend` at line 173, and 5 of 112 in a wider run of the
  ToolGroupFold cases (`below` too), the same way. Under 80 unpinned burners
  (`bun scripts/test-under-contention.ts --burners 80`, 9 workers) it also
  hung there at least twice in 40 runs, among page-load timeouts.
- **Stress:** the same 10x condition after the fix (8 repeats, 6 workers):
  128 of 128 passed for the `above` and `below` cases, 9980's two tests,
  0747's case and the 1,500-call bounded-viewport case, while the unchanged
  spec, run alongside against the same fixed renderer, failed 5 of 128 at
  line 173 again (11.2 min for both). The complete owner under contention,
  `ORKESTRATOR_E2E_PORT=1493 mise run test:logged -- --name tgf-full-after2 -- bun scripts/test-under-contention.ts --burners 16 -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --repeat-each=5 --workers=9 --retries=0`,
  passed 190 of 190.
- **Residual, not reproduced in real runs:** at 10x CPU throttling, two of
  about 250 desktop `above` runs during development failed the existing
  `bottomGap > 100` poll right after the wheel with a gap of 17 px: the
  wheel's scroll stopped 17 px from the end. An instrumented copy did not
  reproduce it in 48 further runs, so its cause is not established. It has
  not been seen without throttling or in any recorded aggregate run.

## Recurrence — 2026-11-13 (container live evidence review repairs)

Mobile `a live group growing below a released reader preserves their place` failed with reduce motion in (c) (`expect(received).toBeGreaterThan(expected)`: expected more than 100, received 40) and in (d), with no-preference motion in (d), and `growing above ... with no-preference motion` failed in (e) (`e2e/ToolGroupFold.spec.ts:201`, the parameterized successor of `:153`). `mise run flaky:recurrence -- 0793 --base 17d28238c` answered that the base contains the fix (`51456e887b`) and that this is a real recurrence, so the case is reopened.

Branch `container-live-evidence-4156bad5e3b0-r1` at `eedd4f1ba`, base `17d28238c098b4443d1289df5c4ed75e7cc2802e`, Linux x86_64 (beelink2, shared with other worktrees' suites), Bun 1.4.4. The branch changes no file under `apps/web`, `packages`, `apps/desktop` or `e2e` (backend tests, the preview worker's seccomp profile, a CI workflow and docs only). Runs: (a) `ORKESTRATOR_REVIEW_VALIDATION=1 mise run test:logged -- --name address-browser-2 -- mise run test:browser` (one retry per test): 22 failed, 11 flaky, 154 skipped, 1,697 passed (41.1 m), host load average 22 to 50 on 16 cores; (b) the 13 failing owners together with `--workers=2`: 2 failed, 5 skipped, 249 passed (5.1 m); (c) to (e) `mise run test:logged -- --name toolgroupfold-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1` three times on a quiet host (load average 3 to 5): 1 failed, 38 passed (1.5 m); 3 failed, 36 passed (1.7 m); 1 failed, 38 passed (1.5 m). The complete owner never ran green alone in these four runs, and a different case failed each time, so this records intermittence in the unchanged owner, not a branch regression. The cause is unconfirmed. 
