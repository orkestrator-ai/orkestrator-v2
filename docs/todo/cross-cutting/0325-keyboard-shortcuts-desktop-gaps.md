# Keyboard shortcuts dialog: packaged native-key qualification

Opened 2026-10-27 with the View › Keyboard Shortcuts… item and native preview
forwarding ([architecture](../../architecture/keyboard-shortcuts.md)).

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Updated 2026-10-30 for the chord change in `19e8b4ce2`: the current shortcut
is ⌘⇧/ / Ctrl+Shift+/. Dated evidence below records the chord tested at the
time; it does not qualify the replacement chord.

The Windows/Linux menu work, its decisions and the menu-navigation fix landed
in `f0a09962` (#1405). They are listed as done. What is left is native
qualification: the CI workflow added for it has failed on every run, and the
packaged-app matrix has not been run on any OS.

The matrix's ⌘K row is corrected to the claim rule in `appClaimsShortcut`
(`packages/protocol/src/keyboard-shortcuts.ts:156-165`), which landed in
`596efc49` (#1406): on macOS, plain Ctrl+K stays with a focused text field
and with an interactive artifact.

### Tasks

1. **Windows/Linux menu layout**: the conventional File, Edit, View, Window and Help layout, no macOS-only roles, no Super accelerators, and Close Tab with no key. Status: done.
2. **Super-key behaviour outside macOS**: Super/Windows renderer handlers stay as they are, and Super+Shift+/ stays accepted. Status: done (decided).
3. **Menu keyboard navigation does not toggle**: choosing View › Keyboard Shortcuts… with Enter opens the dialog; only the chord toggles it. Status: done.
4. **Native menu workflow passes on CI**: `.github/workflows/native-application-menu.yml` passes on Linux/Xvfb and Windows. Status: open (fails on both runners today).
5. **Packaged Linux native qualification**: the matrix below, plus the Linux menu-bar row, on a packaged Linux build. Status: open.
6. **Packaged macOS native qualification**: the matrix below, including the Cyrillic input source, on a packaged macOS build. Status: open (needs a macOS host).

### 1. Windows/Linux menu layout

**Problem.** One template on every platform gave Windows and Linux inert Hide, Hide Others, Show All and Zoom items, Super+H and Super+Alt+H accelerators, and a Close Tab item bound to Super/Windows+W.

**Context.** Decided under "Windows/Linux menu layout" and "Close Tab has no accelerator on Windows and Linux" in Assumptions and decisions.

**Investigation.** Done in `f0a09962`. `createApplicationMenuTemplate` (`apps/desktop/electron/application-menu.ts:84-191`) branches on `actions.platform` (`:87`). The app-name menu is macOS-only (`:92-108`), Close Tab sets `Command+W` only on macOS (`:118-124`), Quit ends File elsewhere (`:125`), Window › Zoom is macOS-only (`:173`), and Help holds Check for Updates… and About outside macOS (`:178-189`). Unit coverage is in `apps/desktop/tests/application-menu.test.ts`; the layout is documented in `docs/architecture/keyboard-shortcuts.md` ("Windows and Linux").

**Decisions.** None; done.

### 2. Super-key behaviour outside macOS

**Problem.** The ⌘-only renderer handlers and the ⌘⇧/ matcher see Super/Windows as `metaKey` outside macOS.

**Context.** Decided under "Super/Windows-key renderer handlers stay as they are" and "Super+Shift+/ stays accepted outside macOS".

**Investigation.** Done. The matcher accepts either modifier (`matchAppShortcut`, `packages/protocol/src/keyboard-shortcuts.ts`), and the menu displays `CmdOrCtrl+Shift+/`, which reads Ctrl+Shift+/ outside macOS. AltGr (Ctrl+Alt) is excluded and covered in `packages/protocol/src/keyboard-shortcuts.test.ts`.

**Decisions.** None; done.

### 3. Menu keyboard navigation does not toggle

**Problem.** Electron sets `triggeredByAccelerator` for Enter-based menu navigation too, so choosing the item with the keyboard toggled an open dialog closed.

**Context.** Found by the native menu fixture run on 2026-10-28 (Current state).

**Investigation.** Done in `f0a09962`. The callback now also requires Shift, no Alt, and the platform's Ctrl or Command modifier before it asks for `toggle` (`apps/desktop/electron/application-menu.ts:156-165`). `e2e/agent-testing/application-menu-electron.spec.ts` checks that a click without the chord opens and a chord click toggles.

**Decisions.** None; done.

### 4. Native menu workflow passes on CI

**Problem.** The workflow that is meant to give Windows its only native evidence, and to repeat the Linux fixture run on a clean runner, has never passed.

**Context.** `.github/workflows/native-application-menu.yml` runs `application-menu-electron.spec.ts` with `ORKESTRATOR_NATIVE_MENU_INPUT=1` on `ubuntu-latest` (under `xvfb-run`) and `windows-latest`. It triggers on pull requests that touch the menu, the shortcut matcher, the spec or `bun.lock`, and on manual dispatch.

**Investigation.** All three runs so far failed on both jobs, with the same errors each time (runs 40766549719 and 40771163989 on the #1405 branch, 40772430610 on the 2.34.3-beta release branch):
- Linux: the resumed-typing step after the About panel closes fails. `expect(page.getByRole("textbox")).toHaveValue("a")` saw `""` (`e2e/agent-testing/application-menu-electron.spec.ts:208-209`). The menu-navigation and accelerator steps before it passed. The local Omarchy run passed this step, so the difference is the runner's display (no window manager under `xvfb-run`) or timing; the uploaded screenshot and error context have not been examined.
- Windows: `closeElectronWithin` fails in its `finally` with "Could not enumerate Electron descendants". `electronProcessTree` runs `ps -axo pid=,ppid=` (`e2e/agent-testing/design-electron-cleanup.ts:16-17`), which Git Bash's `ps` on the runner does not support. Because the error is thrown from `finally`, it hides whether the menu assertions passed.

**Decisions.**

- **How to enumerate the Electron process tree on Windows?**
  - **Make `electronProcessTree` platform-aware: on `win32`, read `ProcessId` and `ParentProcessId` from `Get-CimInstance Win32_Process` through PowerShell (recommended).**
    - Pros: every Electron spec that uses the helper can run on Windows; cleanup still owns exact descendants.
    - Cons: one more PowerShell call per teardown; the helper is shared, so other specs' teardown changes too.
  - **Skip the tree snapshot on `win32` and rely on `app.close()`.**
    - Pros: smallest change.
    - Cons: a hung renderer or GPU process can outlive the job; the cleanup contract differs by platform.
  - **Drop Windows from the matrix.**
    - Pros: the workflow goes green.
    - Cons: Windows keeps no native evidence at all.
- **How to make the Linux resumed-typing step pass?**
  - **Download the failed run's artifact, find why focus did not return, and fix that cause while keeping the assertion strict (recommended).** If the cause is the missing window manager, start a small one (for example `openbox`) before the test.
    - Pros: the step keeps proving that typing resumes after the native dialog, which is the point of the check.
    - Cons: one more package and process in the job; the result then depends on that window manager's focus policy.
  - **Focus the main window and textbox explicitly before typing.**
    - Pros: deterministic.
    - Cons: no longer tests that focus comes back by itself.
  - **Mark the job `continue-on-error`.**
    - Pros: unblocks pull requests at once.
    - Cons: the evidence becomes optional and will be ignored.
- **What counts as a pass?** One green run of both jobs on a pull request or manual dispatch from `main`, with the uploaded menu defaults and About screenshot attached to this file's Current state.

### 5. Packaged Linux native qualification

**Problem.** No packaged Linux build has been driven with native input. The fixture covers the menu template only, not the app's focus surfaces.

**Context.** The rows are under Outstanding work. The 2026-10-28 decision "Native qualification stays open" ruled out packaging and driving the app on this host then. `mise run package:linux` runs `bunx electron-builder --linux --dir` and then `bun scripts/install-packaged-app-linux.ts`, which installs into the desktop (`mise.toml:391-399`). A packaged app's backend defaults to gateway port 34121 (`apps/desktop/electron/backend-process.ts:720`), the live instance's port. `ORKESTRATOR_RUNTIME_PROFILE_FILE` is honoured in packaged builds too (`apps/desktop/electron/main.ts:194`) and moves the data directory and ports, but it also replaces the product name with the profile's title (`:196-198`), which changes what the About panel shows.

**Investigation.** Not started. The two full-app Electron scenarios (`electron-main.spec.ts`, `workspace-realm-electron.spec.ts`) timed out at renderer startup on Xvfb on this host on 2026-10-28 (Current state), before any shortcut assertion. A packaged app on the same display may hit the same startup failure. The Linux menu-bar row is already partly covered by the fixture: Quit/Ctrl+Q, the Help › About role and menu navigation. The fixture's About panel showed "About electron" with no version, because the app sets no `setAboutPanelOptions` (none in `apps/desktop/electron`) and the fixture is not packaged.

**Decisions.**

- **Where and how to run the packaged Linux build?**
  - **Build with `bunx electron-builder --linux --dir` only (no install step), and launch the unpacked binary on an isolated Xvfb display with a window manager, a disposable `HOME`, and a runtime profile file with its own ports. Drive it with XTEST through the helpers in `e2e/agent-testing/native-menu-input.ts` (recommended).**
    - Pros: a packaged build; no desktop entry; no input into the user's session; ports 34121 and 34122 stay free; the helpers already exist.
    - Cons: X11 rather than Wayland; the runtime profile changes the About title, so the About row needs one run without it (with a disposable `HOME` and the live instance's ports checked free) or is recorded from the menu fixture; the renderer-startup timeout must be fixed first.
  - **Install with `mise run package:linux` on a spare Linux machine or VM and run the matrix by hand.**
    - Pros: a real desktop, Wayland, real input methods and the packaged About panel.
    - Cons: needs a person and a second machine; installs into that desktop.
- **What counts as a pass?** Every Linux row recorded with OS and display server, packaged commit, keyboard layout, surface, the separate-press result and the resumed-typing result, as the 2026-10-27 evidence section requires. A row that cannot run on Xvfb (for example one that depends on Wayland focus) is recorded as not run, not as passed.

### 6. Packaged macOS native qualification

**Problem.** macOS menu key equivalents run in AppKit before Chromium; no packaged macOS build has been checked with native input, including a Cyrillic input source.

**Context.** The 2026-10-27 follow-up ran on macOS, but `cua-driver` 0.34.0 had no daemon and the OS did not activate the window, so native-focus assertions were unavailable. This host is Linux. `mise run package:mac` builds and installs an unpacked app (`mise.toml:381-389`).

**Investigation.** Not started. The routing it must confirm now consumes ⌘⇧/ in main's `before-input-event` (`apps/desktop/electron/keyboard-shortcuts-routing.ts`), using the shared matcher's typed `/` or `?` and non-ASCII `Slash`-position fallback, and the menu item keeps `registerAccelerator: false` with the macOS key equivalent as a fallback (`apps/desktop/electron/application-menu.ts:148-166`).

**Decisions.**

- **Who runs it?**
  - **A person on a Mac with `mise run package:mac`, following the matrix by hand (recommended).**
    - Pros: real AppKit key equivalents, real input sources (Cyrillic), real window activation; no automation permissions to grant.
    - Cons: manual; needs someone with a Mac.
  - **Extend the native menu workflow to `macos-latest`.**
    - Pros: repeatable.
    - Cons: synthetic input on a hosted macOS runner needs accessibility permission, and switching input sources there is not straightforward; it covers the fixture, not the packaged app.
  - **An agent on a Mac with a working `cua-driver` daemon.**
    - Pros: unattended once set up.
    - Cons: failed to start on 2026-10-27; window activation was not granted.
- **What counts as a pass?** The same record as task 5, with the macOS version and input source per row.

## Current state

The review follow-up removed the 500 ms press-deduplication window. Desktop
input now has one main-process owner before page and menu dispatch. Artifact
views and design subframes are covered on every desktop platform, and menu
requests resolve realm ownership from child WebContents. Native origin focus
is retained across dismissal, with live/visible checks before restoration.

### Review follow-up evidence (2026-10-27)

The focused routing tests now deterministically clear the focused WebContents
input while retaining a realm preview/artifact as the last focused child. They
check the same target resolver used by Close Tab and the shortcuts menu, window
isolation, sender gating, preview-hook delegation and repeat consumption.
Controller regressions cover reopening before the first restoration callback
and during visibility retries. Browser and Electron scenarios cover outside
pointer dismissal and resumed typing; menu scenarios distinguish an accelerator
`toggle` from `open` while the dialog is already visible.

These checks do **not** qualify packaged native key equivalents. This follow-up
host is macOS; no Linux desktop is available. The installed `cua-driver` 0.34.0
reports no running daemon, and `list_apps` refuses discovery for that reason.
The Electron realm run also recorded its `native-focus` annotation because the
OS did not activate the window; DOM handoffs ran, while native-focus assertions
were unavailable. No native input or packaged-build result is claimed. The packaged macOS/Linux
matrix (Outstanding work) remains open and must be recorded with OS version, packaged commit,
keyboard layout, surface, separate-press result and resumed typing result when
an interactive native qualification environment is available.

### Windows/Linux follow-up (2026-10-28)

A Linux worker audited the Windows/Linux side against Electron 45's source
(`shell/browser/api/electron_api_menu_roles.cc`, `shell/common/keyboard_util.cc`).
Electron maps the `Command` and `Super` accelerator modifiers to Super/Windows
outside macOS, despite the tutorial calling `Command` "N/A" there. The
`hide`, `hideOthers`, `unhide` and `zoom` roles have no action outside macOS.
The shared template therefore gave Windows and Linux three problems:

- Inert Hide, Hide Others, Show All and Window › Zoom items.
- Registered Super+H and Super+Alt+H accelerators for them.
- A File › Close Tab item that registered and displayed Super/Windows+W.
  Window managers and Windows own that key, and the dialog listed Close Tab
  as macOS-only.

Fixed in `apps/desktop/electron/application-menu.ts`. The template now takes
`process.platform`. macOS is unchanged. Windows and Linux get File (… Quit),
Edit, View, Window (no Zoom) and Help (Check for Updates…, About), and Close
Tab has no accelerator. The layout is documented in
[keyboard-shortcuts.md](../../architecture/keyboard-shortcuts.md#windows-and-linux).

New coverage:

- `apps/desktop/tests/application-menu.test.ts`: linux and win32 layouts, no
  macOS-only role, and no `Command`/`Cmd`/`Super`/`Meta` modifier anywhere.
  Close Tab is still clickable. The Ctrl accelerators match the catalog, and
  Keyboard Shortcuts… stays display-only and opens on a click. A macOS case
  pins the app menu roles and Window › Zoom.
- `apps/desktop/tests/keyboard-shortcuts-routing.test.ts`: an Electron
  `Input` with `control` toggles once through main's hook. Its `rawKeyDown`
  is not a second press. AltGr (Ctrl+Alt) passes to the page.
- `packages/protocol/src/keyboard-shortcuts.test.ts`: Windows AltGr is
  rejected. Linux Super (`metaKey`) and Ctrl+Shift+K are accepted, including
  on Cyrillic.
- `apps/web/src/lib/keyboard-shortcuts.test.ts`: `detectShortcutPlatform` for
  `Linux x86_64`, `Linux aarch64`, `Win32`, `MacIntel`, `iPad`, user-agent
  fallback and no navigator. Windows/Linux key caps contain no macOS symbol,
  and macOS caps no `Ctrl`/`Shift`/`Alt`/`Enter`.
- `KeyboardShortcutsDialog.test.tsx`: Windows/Linux rows and footer read
  Ctrl Shift K, with no ⌘/⌥ and no Close Tab row.

At the initial audit, the Electron binary was not installed in this checkout, and
`mise run package:linux` installs the app into the user's desktop. Native key
injection would also drive the user's live Wayland session. So the Linux
items in the matrix (Outstanding work) remain open. The repository has no Windows desktop
package (`package:mac` and `package:linux` only), so the Windows menu branch
was covered by unit tests only. The runtime follow-up below adds native coverage.

### Native menu review follow-up (2026-10-28)

The new `e2e/agent-testing/application-menu-electron.spec.ts` bundles the real
application menu template into a disposable Electron fixture. Its runtime
assertions cover `Menu.buildFromTemplate`, callback argument adaptation, role
labels and default accelerators, including Linux Quit/Ctrl+Q versus Windows
Exit/no default key and the different Redo defaults.

The Linux run passed on Omarchy (Arch), Electron 45.0.0, with an isolated Xvfb
display and the default US layout. XTEST input navigated View › Keyboard
Shortcuts… twice; both selections opened the dialog action. Ctrl+N dispatched,
and the display-only Ctrl+Shift+K did not dispatch from the menu. The built
Help › About role opened the real GTK panel, Escape closed it, and native
typing resumed in the fixture. The panel was titled **About electron** and
showed **electron**, Credits, License and Close, without app name/version
metadata. The run retained its resolved menu defaults and an About screenshot
under `output/agent-testing/native-menu-linux/electron/results.json`.

This run found and fixed a real dispatch issue: Electron sets
`triggeredByAccelerator` for Enter-based menu navigation as well as a chord.
The menu callback now also requires Shift and the platform's Ctrl/Command
modifier before requesting a toggle. Unit cases pin modifier exclusions, and
existing Electron helpers now supply realistic chord modifiers.

The native suite is included in `test:agent:electron`.
`.github/workflows/native-application-menu.yml` runs it with OS input on
Windows and Linux/Xvfb and uploads the menu and About evidence. Linux tools
for this local run were extracted under `/tmp`; no desktop installation or
input into the user's session was needed. Windows execution still needs its
CI runner; no Windows pass is claimed here. These fixture results do not close
the packaged-app, native-focus-surface or macOS input-source matrix (Outstanding work).

The missing-navigator regression now removes `globalThis.navigator` and
restores its property descriptor in `finally`. Removing the detector's
absent-host guard made this test fail with a TypeError; restoring the guard
made the same command pass.

Validation: the web catalog/dialog tests, desktop menu/routing/controller
tests, Electron spec loading, affected web/desktop/e2e typechecks, scoped lint
and repository formatting passed. The isolated native menu command passed
in 2.2 seconds. The two broader Electron scenarios were also attempted with
`bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts workspace-realm-electron.spec.ts --grep 'real Electron main process shares|a leaf.s workspace opens'`
through `test:logged` on Xvfb. Both timed out at renderer startup, before the
shortcut assertions: the title remained `Orkestrator AI` instead of the
profile title for 60 seconds (lines 207 and 221 respectively). The command
failed in 130.9 seconds; evidence is `/tmp/orkestrator-test-run.fA83qr` and
`output/agent-testing/electron-smoke/electron/results.json`. No timeout or
assertion was relaxed, and no passing full-app scenario is claimed for this run.
The preparation run's unrelated aggregate failures in
[1295](../../tests/flaky-tests/aggregate-validation-runs/1295-keyboard-shortcuts-windows-linux-validation.md)
were not repaired or rerun by this test-focused follow-up.

Correction (analysis of 2026-10-28): every run of
`.github/workflows/native-application-menu.yml` so far has failed on both
runners (runs 40766549719, 40771163989 and 40772430610). On Linux the
resumed-typing step after the About panel saw an empty textbox
(`application-menu-electron.spec.ts:209`). On Windows the teardown failed
because `electronProcessTree` runs `ps -axo`
(`e2e/agent-testing/design-electron-cleanup.ts:16-17`). So the workflow has
produced no passing evidence yet; see task 4.

## Outstanding work

### Qualification

Automated Electron checks use Chromium input, which exercises
`before-input-event` but does not qualify the OS's native key-equivalent pass.
Record these checks on packaged macOS and Linux builds:

- ⌘⇧/ / Ctrl+Shift+/ with focus in the sidebar, composer, terminal, Monaco,
  browser/service preview, interactive artifact, design frame and workspace
  realm: one press opens, an immediate separate press closes.
- View › Keyboard Shortcuts… opens the owning realm while its preview has
  focus. Clicking again keeps the dialog and refocuses search.
- Dismiss a preview-originated dialog with Escape, the chord and an outside
  pointer click; typing resumes in that preview. Hidden or disposed previews never regain focus.
- With a Cyrillic input source on macOS, ⌘⇧ and the physical `Slash` key
  open the dialog when it reports a non-ASCII character. On layouts that type
  ASCII, the typed `/` or `?` wins even on another physical key; a different
  ASCII character on `Slash` must not open the dialog. Record the input source,
  physical key and typed character for each case.
- With Monaco focused, ⌘⇧K on macOS / Ctrl+Shift+K on Linux deletes the
  current line without opening the shortcuts dialog, and typing stays in the editor.
- Linux only, in the in-window menu bar: View › Keyboard Shortcuts… shows
  `Ctrl+Shift+/`. Keyboard navigation (Alt, then View, then the item) opens
  the dialog. Repeating it keeps the dialog open. One Ctrl+Shift+/ press
  toggles exactly once. The bar shows File, Edit, View, Window and Help, with
  no Hide, Hide Others, Show All or Zoom item. File › Close Tab has no key, and
  Super+H does nothing in Orkestrator. File › Quit (Ctrl+Q) quits, and Help ›
  About opens Electron's about panel. The app sets no `setAboutPanelOptions`,
  so record what the panel shows.
- ⌘K with focus in the sidebar, composer, Monaco, an interactive artifact, a
  design frame and a workspace realm opens the window's search, which takes
  typing. Ctrl+K does the same on Linux. On macOS, Ctrl+K stays with a focused
  text field (composer, Monaco, a design frame's input) and with an
  interactive artifact (kill-line). In a terminal Ctrl+K still reaches the
  shell (kill-line) and ⌘K opens search. In a browser preview ⌘K stays with
  the page.

## Constraints and rationale

The browser client cannot intercept keyboard events in uncooperative
cross-origin browser/service preview iframes. This origin-isolation limit has
an explicit browser regression test. App-owned design frames relay through a
source-checked bridge; desktop intercepts all these surfaces in native input.

## Assumptions and decisions

### Tasks 5–6: qualify the replacement chord

- **Choice.** Update the open matrix and current routing notes to ⌘⇧/ /
  Ctrl+Shift+/, including typed punctuation and the non-ASCII `Slash` fallback.
- **Why.** `19e8b4ce2` released Shift+K back to the focused surface. Existing
  dated runs remain historical evidence; packaged qualification stays open.

### Windows/Linux menu layout

- **Options.** (a) Keep one template on every platform. (b) Keep the app-name
  menu and drop only the macOS-only roles. (c) Use the conventional
  Windows/Linux layout: Quit ends File, and About and updates move to Help.
- **Choice: (c).**
- **Why.** It matches Electron's own default menu and what Windows/Linux
  users expect. It removes the inert items and their dead Super accelerators.
- **Pros.** No item that does nothing; no Super/Windows key registered by
  Orkestrator; macOS is untouched.
- **Cons.** **Check for Updates…** moves to Help on Windows/Linux, and docs
  had to say so (`docs/development/releasing.md`). (b) would have been a
  smaller diff.

### Close Tab has no accelerator on Windows and Linux

- **Options.** (a) Keep `Command+W` (Super/Windows+W). (b) `CmdOrCtrl+W`
  (Ctrl+W). (c) `Ctrl+F4`. (d) No accelerator; keep the item.
- **Choice: (d).**
- **Why.** Super combinations are window-manager territory on Linux, and
  Windows reserves Win+W. Ctrl+W is the shell's and readline's
  delete-word in terminals and composers, so an accidental tab close is
  likely. Ctrl+F4 is a Windows convention only. The dialog already listed
  Close Tab as macOS-only, so (d) makes the menu agree with it.
- **Pros.** No conflicting key and no false menu label; the catalog stays
  truthful.
- **Cons.** Windows/Linux users have no key for Close Tab. The renderer's ⌘W
  fallback, kept for the browser client, still treats Super+W as `metaKey` in
  an active environment when the window manager lets it through. That
  existing behaviour is undocumented and unchanged.

### Super/Windows-key renderer handlers stay as they are

- **Options.** (a) Gate the ⌘-only renderer shortcuts (⌘T, ⌘R, ⌘E, ⌘G, ⌘O,
  ⌘P, ⌘M, ⌘⇧P…) on macOS. (b) List them as Super shortcuts on Windows/Linux.
  (c) Leave them as they are.
- **Choice: (c).**
- **Why.** Those handlers check `metaKey`, so Super/Windows reaches them when
  the OS lets it through. Listing them would advertise keys that window
  managers and Windows usually take. Gating them would remove working keys
  for no reported problem, across a dozen handlers outside this todo's scope.
- **Pros.** No behaviour change and no false documentation.
- **Cons.** The dialog under-reports on Linux desktops that pass Super
  through.

### Super+Shift+/ stays accepted outside macOS

- **Options.** (a) Accept only Ctrl+Shift+/ outside macOS. (b) Keep accepting
  either modifier.
- **Choice: (b).**
- **Why.** It matches ⌘K / Ctrl+K and the shared, serialisable matcher, and
  needs no platform input. The documented chord is still Ctrl+Shift+/. AltGr
  (Ctrl+Alt on Windows) stays excluded.
- **Pros.** One matcher for the renderer, main, previews and design frames.
- **Cons.** Super+Shift+/ is an extra, unlisted way to open the dialog on
  Linux.

### Native qualification stays open

- **Options.** (a) Package and drive the Linux app here. (b) Keep the native
  matrix open and add Linux-specific rows.
- **Choice: (b).**
- **Why.** The Electron binary is not installed in this checkout, and
  `package:linux` installs a desktop entry. The worker rules forbid changing
  this machine's configuration. Native key injection on Wayland would drive
  the user's live session.
- **Pros.** No machine change and no invented evidence.
- **Cons.** The packaged macOS/Linux key-equivalent behaviour remains
  unqualified.

## Related

- [Keyboard shortcuts](../../architecture/keyboard-shortcuts.md) (living doc).
- [1295](../../tests/flaky-tests/aggregate-validation-runs/1295-keyboard-shortcuts-windows-linux-validation.md)
  (the branch's aggregate validation run).
