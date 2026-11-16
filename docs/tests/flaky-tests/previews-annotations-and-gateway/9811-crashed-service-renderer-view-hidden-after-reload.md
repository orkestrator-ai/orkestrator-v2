# Crashed service renderer: the view read hidden after Reload preview (`service-preview-electron.spec.ts`)

- **ID:** 9811
- **Status:** resolved
- **Date observed:** 2026-11-10 to 2026-11-16
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `67201e449` (the review run), `136ccab06` (the reruns below) and
  `a8b29f805` (the round 3 review run, which already held the first fix; see
  [Second cause](#second-cause-a-notes-panel-left-open-by-the-previous-test)). The branch
  removes legacy tests elsewhere in the spec but does not change this test's
  body, `ServiceBrowserTab`'s desktop-tunnel attach and reload path, or
  `BrowserPreviewManager.reload` for service previews.
- **Test:** `a crashed service renderer reports the failure and recovers on
  reload` in `e2e/agent-testing/service-preview-electron.spec.ts` (line 1025
  on this branch, 1043 before it).
- **Failure:** `expect(view?.visible).toBe(true)` received `false`, right after
  `waitForService("a", "/app/next")`: the reloaded page had loaded, but the
  native view was hidden when the test read it once.
- **Original command:** `mise run test:agent:electron`, one worker, on the
  signed-in user's Hyprland display of a Linux host shared with other
  worktrees, whose account cannot reach the host Docker daemon.

## Observations

The same assertion, at the same line, failed in seven `test:agent:electron`
runs from six other worktrees on this host before this branch existed (the
logged runner's artifacts under `/tmp/orkestrator-test-run.*`):

| Date (UTC) | Worktree | Run result |
| --- | --- | --- |
| 2026-11-10 04:00 | `orkestrator-v2-20261110-013629-ab3ba4c7958a` | 52 passed, 1 failed |
| 2026-11-11 02:30 | `orkestrator-v2-20261111-021338-6ba3314b7f90` | 46 passed, 4 failed |
| 2026-11-11 03:11 | `orkestrator-v2-20261111-021338-6ba3314b7f90` | 45 passed, 5 failed |
| 2026-11-11 19:05 | `orkestrator-v2-20261111-141420-58a6a9a0fc85` | 49 passed, 4 failed |
| 2026-11-13 16:29 | `orkestrator-v2-20261113-083227-2ea1f7178998` | 57 passed, 2 failed |
| 2026-11-14 03:40 | `orkestrator-v2-20261114-021036-abcf26216517` | 51 passed, 5 failed |
| 2026-11-14 04:01 | `orkestrator-v2-20261114-020954-feb7fcaf89ed` | 51 passed, 4 failed |

On this branch it failed in the review run (2026-11-15) and passed in the
next full `test:agent:electron` rerun on the same display. It also passed in a
headless run of the whole owning file
(`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, 21 passed).

## Cause

The spec already describes it beside `visibility()`: a startup dialog can open
at any point after a launch or renderer reload, and it correctly hides native
views. Its dismiss handlers (`dismissStartupDialogs`) run only before a
Playwright locator action or assertion, never during main-process polls. On
this host the "Docker Permission Required" dialog opens after every start and
rechecks every 60 seconds. Every other visibility read in the spec goes
through `expectVisibility`, which gives the handlers a locator assertion
first and polls. This test read `viewsOn` once after `waitForService` (a
main-process poll), so a dialog that opened after the reload left the view
hidden at the moment of the read.

## Reproduction and fix

Forced on 2026-11-16, headless, owning file with `--max-failures=1`: a
modal (`role="dialog"`, `aria-modal="true"`, with a **Continue Without
Docker** button that removes it) appended right after the **Reload preview**
click.

- Before the fix: 5 passed, then this test failed with the recorded
  assertion (`Expected: true`, `Received: false`), 17 did not run.
- After the fix: the same forced dialog, the tests up to and including the
  next one: 7 passed. The dismiss handler closed the dialog and the view came
  back.

The fix reads the view through `expectVisibility("a", [true])`, as the rest of
the spec does. The assertion is unchanged (the one view on that origin is
visible); the read now lets the dialog handler run and polls for up to 30 s,
and a miss records the renderer's role tree.

Verification after the fix, with no forced dialog: three headless runs of the
whole owning file, and the test passed in each (21 passed per run; each run's
one failure is the headless-only case in the note below).

## Second cause: a Notes panel left open by the previous test

The round 3 review run (`mise run test:agent:electron` at `a8b29f805`, on the
signed-in user's Hyprland display, 2026-11-16) failed the same assertion
again, now through `expectVisibility`: the view stayed hidden for the whole
30 s poll, with no dialog in the recorded role tree. The tree showed the
browser tab's **Preview or notes** tablist with **Notes** selected and the
annotations panel open (`Annotations, 0 open on this page` expanded).
`mise run flaky:recurrence -- 9811 --base a8b89f15…` answers "base predates
fix", because it checks only the merge-base; the run's own head held the
first fix, so this is a second cause rather than a stale base.

The previous test, `history, app zoom, DevTools, screenshots and capture
work after reattach`, takes an annotation capture through the preview IPC and
then discards it. A fresh capture opens the Notes panel and selects the Notes
surface (`useBrowserAnnotations`: "A fresh capture always has a visible
editor"); discarding it leaves the panel open, by design. Below the 720 px
annotation breakpoint (`NARROW_ANNOTATION_LAYOUT_PX`) the Notes surface
replaces the preview and correctly hides the native view. Two conditions make
it intermittent:

- The renderer opens the panel only if it reads the `captured` status before
  the discard, which is a race.
- Only a narrow pane hides the view. A tiling display gives the window less
  than 720 px; a headless window is 1440 px wide, where the Notes column only
  shrinks the view, which is why the headless reruns passed.

Reproduced 2026-11-16, headless, the first six tests of the owning file
(`-g`), with the window set to 700 × 900 px at the start of the capture test
and the test waiting for the panel to open:

- Without closing the panel: 5 passed, then this test failed with the
  recorded assertion (`Received: false`) and the same role tree (Notes
  selected).
- With the fix, under the same 700 px window: 6 passed.

The fix is in the capture test, which owns the state: it waits for the
panel to open (so the race no longer decides what the next test inherits),
closes it after the discard, and checks that the view is visible again. The
whole owning file then ran headless with 21 passed; its one failure was the
headless-only case below.

## Note on headless runs

`service-preview-electron.spec.ts` is not in `HEADLESS_CAPABLE_ELECTRON_SPECS`.
In the headless runs used for this case, `a remote terminal link opens the
native localhost forward in a separate browser` failed every time, alone too:
the second window's requests to the local backend's control gateway were
refused by CORS (no credential attached). It passed in the display rerun of
the full suite on the same commit. It is a gap of the unqualified headless
mode, not this case.
