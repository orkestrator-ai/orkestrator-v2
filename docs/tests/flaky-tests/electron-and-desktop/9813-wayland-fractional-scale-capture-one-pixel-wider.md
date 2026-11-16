# Wayland fractional scale: the bootstrap window's capture was one pixel wider (`electron-main.spec.ts`)

- **ID:** 9813
- **Status:** open
- **Date observed:** 2026-11-11 to 2026-11-16
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `a8b29f805` (the round 3 review run). The test bundles
  `apps/desktop/electron/toolchain-bootstrap-window.ts` on its own; neither
  that file nor anything it imports (`app-constants.ts`,
  `@orkestrator/protocol/agent-platforms`, the type-only
  `@orkestrator/toolchain/manager`) changes on this branch, and the branch
  does not change the spec.
- **Test:** `bootstrap window repaints a resized native Wayland surface at
  fractional scale` in `e2e/agent-testing/electron-main.spec.ts` (line 1011).
- **Failure:** `expect(rendering.captureSize).toEqual({ width:
  Math.round(contentWidth * scaleFactor), … })` received a width one pixel
  larger than expected (1897 for 1896; once 942 for 941). Height matched.
- **Original command:** `mise run test:agent:electron`, one worker, on the
  signed-in user's Hyprland display (fractional scale) of a Linux host shared
  with other worktrees.

## Observations

The same assertion, off by one pixel in width, failed in `test:agent:electron`
runs from other worktrees before this branch existed (the logged runner's
artifacts under `/tmp/orkestrator-test-run.*`):

| Date (local) | Run artifact | Received / expected width |
| --- | --- | --- |
| 2026-11-11 03:11 | `orkestrator-test-run.nuap21` | 1897 / 1896 |
| 2026-11-11 19:05 | `orkestrator-test-run.GGlC5Y` | 1897 / 1896 |
| 2026-11-13 16:29 | `orkestrator-test-run.WPeOe5` | 1897 / 1896 |
| 2026-11-14 03:40 | `orkestrator-test-run.8YDIh7` | 942 / 941 |
| 2026-11-14 04:01 | `orkestrator-test-run.pAuKm1` | 1897 / 1896 |

On this branch it failed in the round 3 review run (2026-11-16, 1897 / 1896).
Run alone headless (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`) on the same
commit plus the round 3 fixes, it passed.

## Hypothesis (unproven)

The expected size rounds `contentWidth * scaleFactor` once, while the
compositor sizes the surface's buffer from its own fractional-scale
arithmetic (Wayland's `wp_fractional_scale` works in 1/120 steps), so the two
can disagree by a pixel at some window widths. That would make the
assertion's exact equality too strict for a display-dependent width, but it
has not been checked against the compositor's value. Do not loosen the
assertion until a failing run records the content width and scale that
produced it.
