# Native Chrome branch suggestion fails in the agent launch dialog spec

`e2e/AgentLaunchDialog.spec.ts:18`, `selects a native branch suggestion with
the keyboard and confirms`, fails on `main` at desktop and mobile widths, alone
too: the branch input keeps `rel` instead of `release/2.0`. Found by the
2026-10-25 triage in [0030](0030-test-suite-and-ci-health.md) (task 4).

**Cause (2026-11-01): spec bug.** Chrome never created its datalist popup on the
hosts that run the suite, even for a bare `<input list>` with no React and no
`autocomplete`, so the arrow and Enter keys went to the page. The app's markup
and selection handling are correct. The default case now asserts the
suggestion list and the choice path; the native popup case is opt-in.

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Make the native datalist selection pass or prove the spec wrong**. Status: done
   (2026-11-01): spec bug; the default case asserts the list, the native popup
   case is opt-in (`ORKESTRATOR_E2E_NATIVE_POPUPS=1`). Its run on an unlocked
   desktop is still owed (Qualification).

### 1. Native datalist selection

**Problem.** `mise run test:browser` cannot go green: this owner fails
deterministically, so every component-browser record lists it.

**Context.** The spec drives Chrome's native `<datalist>` popup through the
Chrome channel with `headless: false` (bundled Chromium does not expose it on
macOS). Recorded only inside
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

**Decisions.**

- **How to fix?**
  - **Find whether current Chrome still opens the popup for a focused input
    under automation (one probe), then either drive it the way Chrome now
    accepts or assert the suggestion list instead (recommended).**
    - Pros: evidence first; keeps a real keyboard path if one exists.
    - Cons: native popups differ per Chrome version and platform.
  - **Skip the case.**
    - Pros: green suite.
    - Cons: hides whether keyboard selection works for users.

## Current state

Done in code (2026-11-01). `e2e/AgentLaunchDialog.spec.ts` runs headless in the
default engine. It checks the input's `list`, the datalist's three options, that
choosing `release/2.0` (as the popup does: set the value, fire `input`) keeps the
field valid, and that keyboard confirmation returns it. It passes in WebKit too.
The native popup keys moved to `e2e/AgentLaunchDialogNativePopup.spec.ts`, which
is skipped unless `ORKESTRATOR_E2E_NATIVE_POPUPS=1`. Shared steps are in
`e2e/agent-launch-branch.ts`. Not in CI (`test:browser` is not a CI job).

## Outstanding work

### Code

None.

### Qualification

- `mise run test:browser` with the owner green at both widths: the
  AgentLaunchDialog owner is green (2026-11-01, focused runs below). The
  complete suite is left to the build's validation stage.
  On arktech-mini with `ORKESTRATOR_E2E_PORT=14871`:
  - both specs, `--workers=1 --repeat-each=5`: 20 passed, 10 skipped (the
    opt-in case).
  - `AgentLaunchDialog.spec.ts`, default workers, `--repeat-each=10`: 40 passed.
  - `ORKESTRATOR_E2E_BROWSER=webkit`, both specs: 4 passed, 2 skipped.
  - `ORKESTRATOR_E2E_NATIVE_POPUPS=1` with the session locked: 2 failed with
    `rel`, as the probe predicts.
- Owed: run the opt-in case on an unlocked macOS desktop with Chrome able to
  come to the front. `ORKESTRATOR_E2E_NATIVE_POPUPS=1 mise exec -- bunx
  playwright test --config e2e/playwright.config.ts
  e2e/AgentLaunchDialogNativePopup.spec.ts`. A pass answers the open question
  below. A failure there would be a real Chrome or app regression.

### Review follow-up (2026-11-01)

The review correctly distinguishes `fill()` coverage from native popup selection:
the default test does not prove that Chrome's suggestion UI fills the field.
Keep the unlocked-desktop qualification outstanding until the opt-in spec passes;
passing default tests or skipping the native spec cannot close this gap.

The follow-up host also reports `CGSSessionScreenIsLocked = 1` from
`CGSessionCopyCurrentDictionary()` (queried through Swift/CoreGraphics). The
session cannot supply the required unlocked-desktop qualification.

The follow-up command was:

```bash
ORKESTRATOR_E2E_NATIVE_POPUPS=1 ORKESTRATOR_E2E_PORT=14872 \
  mise run test:logged -- --name agent-launch-native-review -- \
  bunx playwright test --config e2e/playwright.config.ts \
  e2e/AgentLaunchDialogNativePopup.spec.ts --workers=1
```

Result: exit 1, two failures (mobile and desktop), each at the expected
`release/2.0` assertion with actual value `rel`. Separate failure logs are in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.sWlELR`;
Playwright traces are under `output/playwright/test-results/`. The original
review package and its artifacts were left intact. This reproduces the symptom
on a locked host; it does not prove that locking is the only cause or qualify
the native path. The coverage finding remains unresolved pending the unlocked
desktop run above. No test was weakened or skipped to make this run green.

## Constraints and rationale

- No skip without the probe; the case exists because bundled Chromium cannot
  see the popup.
- The popup is Chrome's own UI. What the dialog owns is the `list` link, the
  options and handling the `input` event that a chosen suggestion fires. The
  default case covers those on any host and engine.

## Assumptions and decisions

- 2026-10-31: its own file in cross-cutting, beside the other component-suite
  health work, as 0030 recommended.
- 2026-11-01: followed the recommended option. The probe found no keyboard path
  Chrome accepts while the session is locked: no popup exists to take keys. So
  the default case asserts the suggestion list instead.
- 2026-11-01: kept the native keyboard case, opt-in through
  `ORKESTRATOR_E2E_NATIVE_POPUPS=1`, rather than deleting it. It is the only
  check of the popup a user sees. It is not a plain skip: the default suite still
  covers the dialog's side.
- 2026-11-01: the default case dropped the Chrome channel and `headless: false`.
  `test:browser` no longer needs `playwright install chrome` or opens a visible
  window on a shared build host for this spec.
- 2026-11-01: the default case sets the value with `fill`, which the testing
  guide used to rule out. The guide now says when that is enough.
- Assumption: the build hosts that recorded this failure were in the same locked
  state. Only arktech-mini was checked.

## Open questions

- Does the product's keyboard selection work for a user in current Chrome? The
  opt-in run on an unlocked desktop answers it.

## Needs verification

- Whether it still fails on current `main` and Chrome: yes, on a locked session
  (2026-11-01, probe above).
- Whether the opt-in case passes on an unlocked desktop, which would also
  confirm the lock as the only cause.

## Related

- [0030](0030-test-suite-and-ci-health.md), [0035](0035-mobile-layout-gaps.md), [0202](0202-webkit-title-tooltip-outside-tap.md).

## Replaces

- The "not flakes" note in 0030 item 7 for this spec.
