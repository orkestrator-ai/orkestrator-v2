# Tool group fold: a long group's inner viewport shows no entries in time

- **ID:** 9980
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `14df965440e658e09a7b3ce03530bc1781ac2b01` (`main`).
- **Observed head:** `aa7b41b35` on branch `fix-failing-ci-fc33ea27615f-r1`.
  The branch changes backend code and tests, two other e2e specs and
  documentation; nothing under `apps/web`, `e2e/fixture` or
  `e2e/ToolGroupFold.spec.ts`.
- **Tests:** `a selection inside a long group's viewport survives nearby inner scrolling`
  (`e2e/ToolGroupFold.spec.ts:373`) and
  `focus inside a long group's viewport survives nearby inner scrolling`
  (`e2e/ToolGroupFold.spec.ts:413`)
- **Browser:** Chromium, `desktop-chromium` project.

## Symptom

After clicking `Show 1500 tool calls`, the poll for more than 2
`[data-tool-group-entry-index]` rows inside `[data-transcript-inner-viewport]`
read 0 for its whole 5 s budget (lines 382 and 420).

## Runs

On beelink (Linux x86_64, Bun 1.4.4, Playwright 1.65.0), host load average
about 3 to 6, other worktrees active:

- `mise run test:logged -- --name chromium-paging-fold -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts e2e/ToolGroupFold.spec.ts --workers=2`:
  75 passed, 1 skipped, 2 failed (both tests above, desktop).
- `mise run test:logged -- --name toolgroupfold-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1`:
  37 passed, 1 failed (the focus test, desktop).
- `mise run test:logged -- --name toolgroupfold-inner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --grep "survives nearby inner scrolling" --workers=1 --repeat-each=4`:
  16 passed.

The focus test also failed once in the run recorded in case
[0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md).

## Hypothesis

Unconfirmed. A count of 0, not a small one, suggests the inner viewport had
not mounted its list (or had not measured a height) within 5 s of the click,
rather than a scroll race. That would fit a slow first render of a
1500-call group on a loaded host.

## Resolution (2026-11-11)

Base `51456e887` (`main`), branch `fix-flaky-tests-400972eda2c6-r1`.

- **Root cause:** the click on `Show 1500 tool calls` was lost, so the
  group never opened and its inner viewport never existed (a count of 0, not
  a small one). Pressing the head line focuses its button at pointerdown.
  `VirtualizedMessageList`'s focus protection then grows Virtuoso's overscan
  (`keepMountedOverscan`, two margin rows each side), mounting rows Virtuoso
  had only estimated at 320 px; measuring them shrinks the list by about
  400 px. A follower stays pinned to the end, but a reader who is not
  following and is near the end is clamped by the browser and only put back
  a frame later by `holdPlaceAcrossOverscan` (to the anchor captured when
  they last settled). The button moved between pointerdown and pointerup, so
  pointerup landed on the row's footer, the click went to their common
  ancestor and Radix never toggled the group. A per-event probe showed it:
  pointerdown on the button at y 816, pointerup on `DIV: Assistant · Sep 21`
  at y 772 after `scrollTop` 22662 → 22287, then the hold moving it back.
  A reader stops following without scrolling when virtualizer compensation
  lowers `scrollTop` and raises the gap (the controller's idle departure
  check); such a release was observed directly on this host when rows
  mounted during the group's open animation. The state of the failing runs'
  transcript at the click was not captured, so that this release preceded
  them is inferred from the matching symptom.
- **Fix:** `apps/web/src/components/chat/VirtualizedMessageList.tsx`. When
  the transcript controller reports the reader is not following
  (`controller.wantsFollow === false`), focus that arrives during a press is
  protected once the press ends, in a task after pointerup (the browser
  dispatches the click in the pointerup task, from the same hit test). A
  follower keeps protection at pointerdown as before: deferring it there
  mounted the rows while the click's own growth was being followed, and the
  compensation released the follower (observed: `a 1,500-call group opens in
  a bounded viewport` then failed 3 of 5 mobile repeats with the transcript
  moved 370 px). Keyboard focus is unchanged. Regression tests in
  `VirtualizedMessageList.keep-mounted.test.tsx` (released reader defers, and
  fails against the old code; follower protects at once).
- **Reproduced:** yes, for the mechanism. A probe spec (scratch copy, not
  committed) released the reader 20 to 100 px above the end by wheel or by
  `scrollTop`, then clicked `Show 1500 tool calls` exactly as the owner
  does. Before the fix, mobile Chromium lost the click in 12 of 12 runs at
  60 px and, in a 48-case sweep, 6 of the 24 mobile cases (`opened=false`,
  0 entries, the owner's symptom; a seventh probe timed out). After the fix: 48 of 48 opened with entries rendered,
  and the event probe shows pointerup on the button. The owning tests
  themselves did not fail on this host in 120 nine-worker repeats (host load
  average 100 to 150 from other worktrees), 190 full-owner repeats or under
  CDP CPU throttling of 6x and 20x (failures there were page-load or 30 s
  test timeouts only), so the exact release that preceded the recorded
  failures was not reproduced here.
- **Stress:** `ORKESTRATOR_E2E_PORT=1493 mise run test:logged -- --name tgf-full-after2 -- bun scripts/test-under-contention.ts --burners 16 -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --repeat-each=5 --workers=9 --retries=0`
  passed 190 of 190 (171.5 s). Both owning tests, with Chromium CPU
  throttled 10x (`Emulation.setCPUThrottlingRate`, scratch copy of the spec),
  passed 32 of 32, and the 1,500-call bounded-viewport case 16 of 16, in
  the run recorded in
  [0793](0793-live-tool-group-overscan.md#resolution-2026-11-11).

## Review follow-up (2026-11-11)

- **Committed browser regression:** `a reader released just above the end
  opens a long group with one click` (`e2e/ToolGroupFold.spec.ts`,
  `mobile-chromium` only; desktop pulls a reader 60 px from the end back to
  it). It releases the reader by a 60 px wheel, waits until the reader has
  settled, clicks `Show 1500 tool calls` once and asserts the group opens
  with entries rendered. Against the pre-fix `VirtualizedMessageList.tsx`:
  12 of 12 failed (`--repeat-each=12 --workers=4`, the inner viewport never
  appeared). With the fix: 12 of 12 passed.
- **Press without a release:** a press now also ends at a non-modifier key,
  a context menu, a native drag or the window losing focus, so a missing
  `pointerup` cannot defer later keyboard focus. Unit tests in
  `VirtualizedMessageList.keep-mounted.test.tsx` cover these ends,
  `pointercancel`, focus that supersedes a pending protection, and a second
  press that begins before the first's protection runs.

## Recurrence — 2026-11-13 (container live evidence review repairs)

Desktop `a selection inside a long group's viewport survives nearby inner scrolling` (`e2e/ToolGroupFold.spec.ts:449`) failed in (b): `expect(received).toBeGreaterThan(expected)`, expected more than 2 entries, received 0. It passed in (a), (c), (d) and (e). `mise run flaky:recurrence -- 9980 --base 17d28238c` answered that the base contains the fix (`51456e887b`) and that this is a real recurrence, so the case is reopened.

Branch `container-live-evidence-4156bad5e3b0-r1` at `eedd4f1ba`, base `17d28238c098b4443d1289df5c4ed75e7cc2802e`, Linux x86_64 (beelink2, shared with other worktrees' suites), Bun 1.4.4. The branch changes no file under `apps/web`, `packages`, `apps/desktop` or `e2e` (backend tests, the preview worker's seccomp profile, a CI workflow and docs only). Runs: (a) `ORKESTRATOR_REVIEW_VALIDATION=1 mise run test:logged -- --name address-browser-2 -- mise run test:browser` (one retry per test): 22 failed, 11 flaky, 154 skipped, 1,697 passed (41.1 m), host load average 22 to 50 on 16 cores; (b) the 13 failing owners together with `--workers=2`: 2 failed, 5 skipped, 249 passed (5.1 m); (c) to (e) `mise run test:logged -- --name toolgroupfold-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1` three times on a quiet host (load average 3 to 5): 1 failed, 38 passed (1.5 m); 3 failed, 36 passed (1.7 m); 1 failed, 38 passed (1.5 m). The complete owner never ran green alone in these four runs, and a different case failed each time, so this records intermittence in the unchanged owner, not a branch regression. The cause is unconfirmed. 
