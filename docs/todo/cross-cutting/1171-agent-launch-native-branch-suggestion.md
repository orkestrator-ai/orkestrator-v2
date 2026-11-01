# Native Chrome branch suggestion fails in the agent launch dialog spec

`e2e/AgentLaunchDialog.spec.ts:18`, `selects a native branch suggestion with
the keyboard and confirms`, fails on `main` at desktop and mobile widths, alone
too: the branch input keeps `rel` instead of `release/2.0`. Found by the
2026-10-25 triage in [0030](0030-test-suite-and-ci-health.md) (task 4).

**Cause (2026-11-01): spec bug.** The spec ran a headed Chrome window on build
hosts whose macOS session is locked. That window never has browser-side focus,
so Chrome dropped every datalist popup it was asked to show
(`kNoFrameHasFocus`), and the arrow and Enter keys went to the page. Chrome's
own histograms show the app's suggestions reaching the popup controller. The
spec now runs the full bundled Chromium in new headless mode with a larger
screen, and the native keyboard selection passes on a locked host at both
widths.

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Make the native datalist selection pass or prove the spec wrong**. Status: done
   (2026-11-01): spec bug. `e2e/AgentLaunchDialogNativePopup.spec.ts` drives
   Chromium's own popup in new headless mode and runs by default; it passed
   30 of 30 at both widths on a locked host (Qualification).

### 1. Native datalist selection

**Problem.** `mise run test:browser` cannot go green: this owner fails
deterministically, so every component-browser record lists it.

**Context.** Until 2026-11-01 the spec drove Chrome's native `<datalist>` popup
through the Chrome channel with `headless: false`, because Playwright's default
headless shell has no such popup. Recorded only inside
[0493](../../tests/flaky-tests/aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md):
the complete one-worker owner reproduced it ("two passed, two failed, input
`rel` instead of `release/2.0`"); [0035](0035-mobile-layout-gaps.md) saw the
same two failures.

**Investigation.** Not rerun this round. The keyboard steps type `rel`, then
expect the popup's arrow-and-Enter to fill the option; the value stays as
typed, so the popup selection never applies.

**Probe (2026-11-01, `main` at `93b99bfba`, arktech-mini, Chrome
156.0.8078.74, Playwright 1.64.0).**

- The unchanged spec still failed at both widths, alone (`--workers=1`): two
  passed, two failed, value `rel`.
- A throwaway probe spec (not committed) ran the same keys against three
  inputs: the app's dialog, a bare `<input list>` page, and the bare page with
  `autocomplete="off"`, each with and without `page.bringToFront()`. All six
  kept `rel`. A capturing `keydown` listener received `ArrowDown` and `Enter`
  every time. Chrome intercepts those keys before the page while its popup is
  open, so no popup was open.
- `CGWindowListCopyWindowInfo` for the test's Chrome process listed only the
  1026x960 browser window before the click, after the click and after typing
  `rel`. Chrome never created a popup window.
- `CGSessionCopyCurrentDictionary` reported `CGSSessionScreenIsLocked = 1`, and
  `lsappinfo front` named `loginwindow`. No app can become active in a locked
  session. `page.bringToFront()` did not change that, and `document.hasFocus()`
  was `true` throughout (Playwright emulates page focus). Chromium's
  `PopupViewViews::Show` reports failure when its widget is not active
  (`return !CanActivate() || (GetWidget() && GetWidget()->IsActive());`). That
  fits, but the source was not traced further.

So the failure belongs to the host's desktop state, not to the dialog. The
records in 0493, 0035, 0382, 0963 and 1012 came from runs on build hosts like
this one. The case passed when it landed in #997, presumably on an unlocked
desktop.

**Second probe (2026-11-01, same host, still locked, Chromium build 1248 and
Chrome 156).** A throwaway spec (not committed) read Chrome's own UMA
histograms over CDP (`Browser.getHistograms`) after typing `rel`.
`Autofill.DataList.Events` had samples in every run, so the renderer sent the
datalist options and the browser's popup controller received them. The app's
side works. `Autofill.PopupHidingReason.DataList` then named why each popup
closed (values from Chromium's `SuggestionHidingReason`):

| Browser setup | Hiding reason | Value after ArrowDown, Enter |
| --- | --- | --- |
| Chrome channel, headed (the old spec) | `kNoFrameHasFocus` (23) every time | `rel` |
| Chrome channel, new headless, default screen | `kInsufficientSpace` (13) | `rel` |
| New headless, `--screen-info={0,0 2000x2000}`, Playwright `keyboard.press` | `kViewDestroyed` (11) on ArrowDown | `rel` |
| Same, CDP `rawKeyDown` without native key code | `kViewDestroyed` (11) on ArrowDown | `rel` |
| Same, CDP `rawKeyDown` with native key code (the spec's keys) | `kAcceptSuggestion` (0) on Enter | `release/2.0` |
| Bundled Chromium (`channel: "chromium"`), same settings | `kAcceptSuggestion` (0) on Enter | `release/2.0` |
| Default headless shell (no channel) | none: no popup at all | `rel` |

`kNoFrameHasFocus` comes from `AutofillPopupControllerImpl::Show`, which hides
a root popup when the tab's `RenderWidgetHostView` lacks focus. Playwright only
emulates focus inside the page (`document.hasFocus()` was `true`), so a headed
window on a locked desktop fails there. New headless mode gives the window
focus without a desktop, but its default 800x600 screen is smaller than the
1024x900 viewport, so the popup had no room. The final two rows passed at both
widths.

**Decisions.**

- **How to fix?** Chosen: the recommended option. The second probe found a way
  Chrome accepts (new headless, larger screen, native key codes), so the spec
  drives the popup rather than only asserting the list.
  - **Find whether current Chrome still opens the popup for a focused input
    under automation (one probe), then either drive it the way Chrome now
    accepts or assert the suggestion list instead (recommended).**
    - Pros: evidence first; keeps a real keyboard path if one exists.
    - Cons: native popups differ per Chrome version and platform.
  - **Skip the case.**
    - Pros: green suite.
    - Cons: hides whether keyboard selection works for users.

## Current state

Done in code (2026-11-01).

- `e2e/AgentLaunchDialogNativePopup.spec.ts` runs by default in `test:browser`.
  It uses `channel: "chromium"` (the full bundled build, which
  `mise run playwright:install` already downloads) in new headless mode with
  `--screen-info={0,0 2000x2000}`, types `rel`, sends ArrowDown and Enter as CDP
  `rawKeyDown` events with platform-native key codes, and checks the field holds
  `release/2.0` and the dialog confirms it. It opens no visible window and
  needs no Chrome install or unlocked desktop. On failure it appends Chrome's
  datalist hiding reasons to the error.
- `e2e/AgentLaunchDialog.spec.ts` still checks the list link, the options and
  the choice path (`fill`) in every engine, including WebKit.
- The opt-in switch `ORKESTRATOR_E2E_NATIVE_POPUPS` is gone.
- Shared steps are in `e2e/agent-launch-branch.ts`. Not in CI (`test:browser`
  is not a CI job).

## Outstanding work

### Code

None.

### Qualification

On arktech-mini, session locked (`CGSSessionScreenIsLocked = 1`), load average
about 50 to 67, `ORKESTRATOR_E2E_PORT=14876`:

- Both specs, default workers, `--repeat-each=10`: 60 passed, including the
  native popup case 20 of 20 (10 mobile, 10 desktop).
- Both specs, `--workers=1 --repeat-each=5`: 30 passed (native case 10 of 10).
- `ORKESTRATOR_E2E_BROWSER=webkit`, both specs: 4 passed, 2 skipped (the native
  case is Chromium only).
- Negative checks, each reverted: without `--screen-info` the case fails with
  `rel` and the message `Chrome hid its datalist popups with:
  kInsufficientSpace x5`; on the default headless shell it fails with `none
  recorded`.

Review-fix Linux qualification (2026-11-01), using a clean archive of
`a668b4a37` in a disposable `orkestrator-v2:dev-cc80206a42eb` container
(Debian 13, Linux aarch64, Bun 1.4.4, Playwright 1.64.0, bundled Chromium
156.0.8078.4, revision 1248; `--shm-size=1g`). Dependencies were installed
inside the container with `bun install --frozen-lockfile`; no host dependencies
or application data were mounted.

```bash
mise run test:logged -- --name todo1171-linux-popup -- \
  docker exec -w /workspace -e CI=1 -e ORKESTRATOR_E2E_PORT=14879 \
  todo1171-linux-qualification bunx playwright test \
  --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts \
  e2e/AgentLaunchDialogNativePopup.spec.ts --workers=2 --repeat-each=5
```

- Before the fix: 20 passed, all 10 native cases failed at both widths with
  `rel` and `kRendererEvent x1, kViewDestroyed x1`.
- Fix: send Linux XKB native key codes (ArrowDown 116, Enter 36), in addition
  to the Windows virtual key codes. The macOS codes remain 125 and 36.
- The exact command after copying the fixed spec into the container: 30 passed,
  including all 10 native selections, without retries or skips (66.8 s).
- macOS regression: both specs, `--workers=2`, port 14880: 6 passed (51.0 s).
- The container was removed after qualification. This qualifies Linux arm64;
  Linux x64 and Windows were not exercised by this follow-up.

The complete `mise run test:browser` is left to the build's validation stage.

Not checked: a headed run on an unlocked desktop. The spec no longer needs it.
The popup code it runs is the same, but a headed window is not exercised.

### Review follow-up (2026-11-01)

The review correctly found that `fill()` does not prove Chrome's suggestion UI
fills the field, and that the opt-in run on this locked host still failed
(exit 1, `rel` at both widths, command below). That run was headed Chrome:

```bash
ORKESTRATOR_E2E_NATIVE_POPUPS=1 ORKESTRATOR_E2E_PORT=14872 \
  mise run test:logged -- --name agent-launch-native-review -- \
  bunx playwright test --config e2e/playwright.config.ts \
  e2e/AgentLaunchDialogNativePopup.spec.ts --workers=1
```

Resolved by the second probe: the native case now runs headless, by default,
and passes on the locked host. The unlocked desktop it waited on is no longer
needed.

## Constraints and rationale

- No skip without the probe. The headless shell, Playwright's default for
  headless Chromium, has no popup, so the spec must pick the `chromium` channel.
- The popup is Chrome's own UI. What the dialog owns is the `list` link, the
  options and handling the `input` event that a chosen suggestion fires. The
  default case covers those on any host and engine.

## Assumptions and decisions

- 2026-10-31: its own file in cross-cutting, beside the other component-suite
  health work, as 0030 recommended.
- 2026-11-01 (superseded by the headless probe below): the initial probe found
  no working keyboard path in headed Chrome while the session was locked, so
  the default case temporarily asserted the suggestion list instead. The later
  probe found the headless path now used by the default native case.
- 2026-11-01 (superseded below): kept the native keyboard case, opt-in through
  `ORKESTRATOR_E2E_NATIVE_POPUPS=1`, rather than deleting it.
- 2026-11-01: the default case dropped the Chrome channel and `headless: false`.
  `test:browser` no longer needs `playwright install chrome` or opens a visible
  window on a shared build host for this spec.
- 2026-11-01: the default case sets the value with `fill`, which the testing
  guide used to rule out. The guide now says when that is enough.
- Assumption: the build hosts that recorded this failure were in the same locked
  state. Only arktech-mini was checked. The fix does not depend on it: new
  headless mode needs no desktop.
- 2026-11-01, after review: the native case runs by default, headless, through
  `channel: "chromium"` rather than the Chrome channel. It passes on a locked
  host, needs no `playwright install chrome`, and opens no window on a shared
  build host. The opt-in switch was removed.
- 2026-11-01: `--screen-info={0,0 2000x2000}` rather than `viewport: null` with
  `--window-size`. Both gave the popup room in the probe; the screen switch
  keeps the projects' mobile and desktop viewports.
- 2026-11-01: kept the 500 ms wait after typing. Neither the DOM, the page's
  accessibility tree nor the input's computed style shows that the popup is
  open, and Chrome's datalist histograms do not map cleanly to "open now". The
  browser handles ArrowDown and Enter before the next CDP command, so no wait
  sits between them.
- 2026-11-01: on failure the spec reads `Autofill.PopupHidingReason.DataList`.
  It is Chrome's internal metric and its values could change, so it is only
  used in the failure message, never asserted.

### Task 1: Linux keyboard qualification

- 2026-11-01: chose a disposable Linux container with independently installed
  pinned dependencies to exercise the default native case. The omitted native
  key codes reproduced the review concern; supplying Linux codes fixes it
  without weakening the selection assertion or changing the macOS path.

## Open questions

- Does a headed Chrome on an unlocked desktop still select the same way? It is
  no longer needed for the suite; it would only confirm the headed path.

## Needs verification

- Whether it still fails on current `main` and Chrome: yes, headed on a locked
  session (2026-11-01, probes above).
- Whether the native case passes repeatedly: yes, 30 of 30 at both widths on a
  locked, loaded host (Qualification).

## Related

- [0030](0030-test-suite-and-ci-health.md), [0035](0035-mobile-layout-gaps.md), [0202](0202-webkit-title-tooltip-outside-tap.md).

## Replaces

- The "not flakes" note in 0030 item 7 for this spec.
