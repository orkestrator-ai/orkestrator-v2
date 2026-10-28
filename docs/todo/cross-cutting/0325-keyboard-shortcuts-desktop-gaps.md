# Keyboard shortcuts dialog: packaged native-key qualification

Opened 2026-10-27 with the View › Keyboard Shortcuts… item and native preview
forwarding ([architecture](../../architecture/keyboard-shortcuts.md)).

The review follow-up removed the 500 ms press-deduplication window. Desktop
input now has one main-process owner before page and menu dispatch. Artifact
views and design subframes are covered on every desktop platform, and menu
requests resolve realm ownership from child WebContents. Native origin focus
is retained across dismissal, with live/visible checks before restoration.

Automated Electron checks use Chromium input, which exercises
`before-input-event` but does not qualify the OS's native key-equivalent pass.
Record these checks on packaged macOS and Linux builds:

- ⌘⇧K / Ctrl+Shift+K with focus in the sidebar, composer, terminal, Monaco,
  browser/service preview, interactive artifact, design frame and workspace
  realm: one press opens, an immediate separate press closes.
- View › Keyboard Shortcuts… opens the owning realm while its preview has
  focus. Clicking again keeps the dialog and refocuses search.
- Dismiss a preview-originated dialog with Escape, the chord and an outside
  pointer click; typing resumes in that preview. Hidden or disposed previews never regain focus.
- With a Cyrillic input source on macOS, ⌘⇧ and the K key open the dialog.
- Linux only, in the in-window menu bar: View › Keyboard Shortcuts… shows
  `Ctrl+Shift+K`. Keyboard navigation (Alt, then View, then the item) opens
  the dialog. Repeating it keeps the dialog open. One Ctrl+Shift+K press
  toggles exactly once. The bar shows File, Edit, View, Window and Help, with
  no Hide, Hide Others, Show All or Zoom item. File › Close Tab has no key, and
  Super+H does nothing in Orkestrator. File › Quit (Ctrl+Q) quits, and Help ›
  About opens Electron's about panel. The app sets no `setAboutPanelOptions`,
  so record what the panel shows.

The browser client cannot intercept keyboard events in uncooperative
cross-origin browser/service preview iframes. This origin-isolation limit has
an explicit browser regression test. App-owned design frames relay through a
source-checked bridge; desktop intercepts all these surfaces in native input.

## Windows/Linux follow-up (2026-10-28)

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

Not run here: the Electron binary is not installed in this checkout, and
`mise run package:linux` installs the app into the user's desktop. Native key
injection would also drive the user's live Wayland session. So the Linux
items in the matrix above remain open. The repository has no Windows desktop
package (`package:mac` and `package:linux` only), so the Windows menu branch
is covered by unit tests only.

## Assumptions and decisions

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

### Super+Shift+K stays accepted outside macOS

- **Options.** (a) Accept only Ctrl+Shift+K outside macOS. (b) Keep accepting
  either modifier.
- **Choice: (b).**
- **Why.** It matches ⌘K / Ctrl+K and the shared, serialisable matcher, and
  needs no platform input. The documented chord is still Ctrl+Shift+K. AltGr
  (Ctrl+Alt on Windows) stays excluded.
- **Pros.** One matcher for the renderer, main, previews and design frames.
- **Cons.** Super+Shift+K is an extra, unlisted way to open the dialog on
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

## Review follow-up evidence (2026-10-27)

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
matrix above remains open and must be recorded with OS version, packaged commit,
keyboard layout, surface, separate-press result and resumed typing result when
an interactive native qualification environment is available.
