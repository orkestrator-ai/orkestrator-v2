# Service preview keyboard picker misses "Register a service…"

- **ID:** 0620
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `the picker, service dialog, diagnostics and Cmd/Ctrl+L work from
  the keyboard` in `e2e/agent-testing/service-preview-electron.spec.ts`
  (`chooseFromPicker("svc-a", /^Register a service/)`, the picker's third
  keyboard opening in that test).
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-0a835-final2-1 bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`
  (and `…-final3-4`, `…-final3-5`), one worker, on a macOS 27.0 arm64 host
  shared with other live-test worktrees, some running their own Electron
  windows (load average 12 to 31).
- **Failures (3 of 14 full runs of the owning file):**
  - `final2-1` and `final3-4`: arrow keys stopped moving focus in the open
    menu. The focus trail stayed on `svc-b` for the remaining presses, down
    and up, so the item was never reached (menu items were
    `svc-a, svc-b, Register a service…, Backend host port (manual)…`).
  - `final3-5`: the item was focused and chosen with Enter, the menu closed,
    and the **Register preview service** dialog was not visible within
    5 seconds.
- **Passes:** the same file passed 13/13 in the other 11 runs, including the
  last 6 in a row (`svc-preview-0a835-diag-1` to `-6`), and the keyboard test
  passed alone each time it was run alone.
- **Not the cause:** a pointer left over the menu (Chromium's synthetic hover
  moves Radix focus) produced a similar trail earlier and is fixed in the
  spec, which now parks the pointer. `final3-4` and `final3-5` came after
  that change. The spec now also gives the app window native focus first
  (`focusApp`); the 6 passing runs came after that.
- **Recurrence in the full Electron suite** (`ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-0a835-suite mise run test:logged -- --name agent-electron-0a835 -- mise run test:agent:electron`):
  24 passed, 1 failed (this test), 1 skipped, 3 did not run. The page still
  had focus (`document.hasFocus()` true), so OS focus theft
  ([0271](../electron-and-desktop/0271-electron-native-focus-shared-macos-desktop.md)) is ruled out.
  Trail: `svc-a`, `svc-b`, then `svc-b` for every further ArrowDown, then
  `svc-a` for every ArrowUp.
- **Cause (likely):** Radix's roving focus moves focus to the next item in a
  `setTimeout` (`@radix-ui/react-roving-focus` 1.2.1, `focusFirst`). The spec
  read focus right after each key press. Chromium throttles timers in a
  window other windows cover (other worktrees' Electron tests share this
  desktop), so the read was stale and the loop pressed on or gave up. The same
  throttling fits the "dialog never appeared" variant.
- **Change (2026-10-21):** the spec waits up to 2 seconds for focus to move
  after each key, and launches Electron with
  `--disable-backgrounding-occluded-windows`, `--disable-background-timer-throttling`
  and `--disable-renderer-backgrounding`. No timeout was raised for any
  assertion and no test was skipped. Keep the case open until the spec has
  passed in loaded full-suite runs; if it holds, consider the same switches
  for every Electron spec (`electron-launch-switches.ts`).
- **On recurrence, record:** the trail now includes `(page unfocused)` when
  `document.hasFocus()` is false, and a missing dialog reports the dialogs in
  the DOM, the address value and the focused element. That tells focus theft,
  a lost key, and a dialog that opened and closed apart.
- **Evidence:** `output/agent-testing/svc-preview-0a835-final2-1`,
  `-final3-4`, `-final3-5` (failures) and `-diag-1` to `-diag-6` (passes).

## Agent-interactions main merge recurrence, 2026-10-22

`mise run test:logged -- --name merge-electron -- mise run test:agent:electron` failed the keyboard picker case alongside three other cases (18 passed, 4 failed, 1 skipped, 7 did not run; 846.4 s). `mise run test:logged -- --name merge-electron-owner-service-preview-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts --workers=1 service-preview-electron.spec.ts` passed the complete unchanged owner (64.2 s). Original evidence: `orkestrator-test-run.oTkYDB/merge-electron.log.gz` under the host temporary directory. No assertion, timeout, skip or implementation changed.

## Command-handover repair follow-up — 2026-10-23

`mise run test:logged -- --name handover-electron -- mise run test:agent:electron`
failed this owner at `chooseFromPicker`, this time while focusing
`Preview service svc-b`: the element detached during a renderer navigation and
`locator.focus` exceeded 30 seconds. Source edits overlapped the beginning of
this suite, so this observation does not establish the earlier roving-focus
hypothesis as its cause. The suite reported 23 passed, two failed, one skipped,
and six not run (400.3 s); the other failure concerned native annotation focus.

`mise run test:logged -- --name handover-electron-preview-owner -- bunx playwright
test --config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/service-preview-electron.spec.ts --workers=1` passed the
complete unchanged owner in 62.6 s after source edits stopped. Original evidence:
`orkestrator-test-run.NWWiZg/handover-electron.log.gz` under the host temporary
directory. No preview implementation, assertion, timeout or skip changed.

## Service preview rollout (0042) — 2026-10-25

No recurrence: the keyboard test passed in all 7 runs where it ran on branch
`todo-0042-service-preview-rollout-f64ae24ade8a` (5 single-spec runs and 2
full `test:agent:electron` suites, load 21 to 80). The three throttling
switches the fix added (`--disable-backgrounding-occluded-windows`,
`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`)
now live in `ELECTRON_TEST_SWITCHES` (`e2e/agent-testing/electron-launch-switches.ts`),
so every Electron spec launches with them. Left open for one more loaded
observation window before resolving.
