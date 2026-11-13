# Inspector transcript: a follower's stable-end check sees one frame under WebKit

- **ID:** 9976
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `17d28238c` (`main`).
- **Observed head:** branch `webkit-macos-input-9c0ac85051e8-r1` (the to-do 7766
  fix: one change to the transcript controller's growth pin and the spec's
  `wheelUpFromEnd`, both after this assertion in the test). The first macOS
  observation predates the controller change, with only the spec helper
  changed.
- **Test:** `Graph Run shows the newest message when its pane returns`
- **File:** `e2e/InspectorTranscriptHide.spec.ts`, `expectStableEnd`'s
  `expect(samples.length).toBeGreaterThan(1)`, reached from the follower part
  of the test (after "Append transcript entry" and showing the pane again),
  before any wheel input.
- **Browser:** Playwright WebKit (`ORKESTRATOR_E2E_BROWSER=webkit`),
  `desktop-chromium` project both times. Not seen in Chromium.

## Symptom

`Expected: > 1`, `Received: 1`. `expectStableEnd` samples every animation
frame for 750 ms and stops early when a frame leaves the end (bottom gap over
1 px) or the overview has moved. One sample means either the first frame broke
the loop, or a single frame took 750 ms. The assertion order hid which.

## Runs

- macOS 27.2 on arktech-mini, Playwright 1.65.0 WebKit 27.2 (build 2388)
  installed natively, load average about 50 with nine other builds:
  `ORKESTRATOR_E2E_BROWSER=webkit ORKESTRATOR_E2E_PORT=15766 bunx playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=2 --repeat-each=3`:
  41 passed, 1 failed here (repeat 2).
- Linux WebKit: the same command with `--workers=2 --repeat-each=3` and
  `PW_TEST_CONNECT_WS_ENDPOINT` pointing at `npx playwright@1.65.0 run-server`
  in `mcr.microsoft.com/playwright:v1.65.0-noble` (arm64, Docker Desktop),
  the fixture server on the Mac, load average about 23: 39 passed, 3 failed,
  one of them here (the other two were `page.goto` timeouts).
- **Isolated rerun:** `--grep "Graph Run shows the newest message" --workers=1 --repeat-each=10`
  in the same Linux WebKit: 20 passed.
- Resolved case [6380](6380-inspector-transcript-hide-webkit-offset.md) saw the
  same failure once in 2026-11-06's runs and found no cause.

## Hypothesis

Unconfirmed. Both observations were on a heavily loaded host, where one
WebKit frame can exceed 750 ms. A first frame away from the end (the
follower's pin landing a frame late after the pane is shown) would fail the
same way and be a product defect.

## Change in this case

`expectStableEnd` now checks every sample's bottom gap and overview offset
before the sample count, so the next failure says whether the first frame left
the end, moved the overview, or was the only frame in 750 ms. No threshold,
wait or assertion was loosened.
