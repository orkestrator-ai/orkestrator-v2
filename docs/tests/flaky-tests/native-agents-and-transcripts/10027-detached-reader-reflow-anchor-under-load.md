# Detached reader reflow: the anchor drifted past 3 px under load (`e2e/StreamingTranscript.spec.ts`)

- **ID:** 10027
- **Status:** resolved
- **Date observed:** 2026-11-23
- **Test:** `e2e/StreamingTranscript.spec.ts:307 › a detached reader holds their
  place through a reflow in either direction` (both projects).
- **Failure:** `expect(probe.maxError).toBeLessThanOrEqual(3)` at line 346: the
  anchored part moved 113.75 px (mobile project) during one of the two viewport
  resizes; in an earlier run 91 px (desktop project).
- **Base commit:** `6e072c3cf` (branch `optimize-browser-tests-3b10dfb32710-r1`,
  which builds the component suite's fixture page instead of serving it through
  Vite's dev server; it changes no transcript or scroll code).

## Observations

1. `mise run test:logged -- --name test-browser -- mise run test:browser` on
   beelink (16 cores), 5 workers, host load 15 to 25 from other worktrees:
   2,006 passed, 165 skipped, 3 failed (13.3 min). The other two failures were
   flake [1012](../web-ui/1012-live-tool-fold-threshold-gap.md). Mobile project,
   113.75 px.
2. The same branch's earlier whole run with 8 workers failed the case on one
   project (91 px).
3. The fixed-workers dev-server baseline at the same base (5 workers, quieter
   host) did not fail it.

## Isolated and stress reruns

- `bun scripts/loopback-network.ts --free-port ORKESTRATOR_E2E_PORT -- bunx
  playwright test --config e2e/playwright.config.ts
  e2e/StreamingTranscript.spec.ts:307 --repeat-each=8 --workers=4`: 16 of 16
  passed with the fixture build, and 16 of 16 with
  `ORKESTRATOR_E2E_FIXTURE_SERVER=dev`.
- The whole owning file, `--repeat-each=6 --workers=10`, host load rising to
  about 40: the fixture build passed 156 of 156 (56.7 s). The dev server
  failed this case twice on the desktop project (154 passed, 2.0 min).

## Hypothesis

The probe samples the anchor's position for 800 ms after each resize. Under
CPU starvation, a reflow that lands between the resize and the scroller's
anchor correction is sampled before the correction runs. That is a timing gap
a slow machine could also show a user, not only a slow test, and it occurs with
either fixture server. The cause is unconfirmed.

## Resolution (2026-11-25)

- **Root cause:** the probe. The hypothesis above is right about the moment but
  not about the screen: the resize reached the page between a frame's
  `requestAnimationFrame` and the task that samples, so the sample laid out the
  new width before the frame that renders it, and its anchor correction, had run.
- **Fix:** `e2e/painted-frames.ts` skips such samples
  ([1012](../web-ui/1012-live-tool-fold-threshold-gap.md#resolution-2026-11-25)).
  The 3 px limit and the checks that rows re-wrapped and that samples were taken
  are unchanged.
- **Reproduced:** yes. `-g "detached reader holds their place through a reflow in" --repeat-each=20 --workers=8`
  pinned to four cores failed 5 of 40 on this assertion, at 113.75 px and 91 px.
  All five violating samples had an `innerWidth` (420 or 1200) other than their
  frame's. With the fix, `--repeat-each=25` had no failure on this assertion in
  50 runs.
- **Not covered:** two of those 50 runs (and one of the 40 before) failed
  earlier, at the `lastOutcome` poll, with `expired`: the history jump's hold ran
  out under that starvation. It is a different assertion and was not changed.
- **Stress:** the command above.
