# Keyboard shortcuts

Two kinds of shortcut exist. **App-level** shortcuts belong to the
application and work wherever focus is in the window: the sidebar, the main
area, the composer, a terminal, Monaco, another node's workspace, a design
frame or an interactive artifact. **Local** shortcuts belong to the surface
that owns them (the composer's Enter, a terminal's copy, the design canvas's
keys, ⌘R and the other environment keys) and work only while it has focus.

The app-level shortcuts are:

| Shortcut | Opens | Owner |
| --- | --- | --- |
| ⌘K / Ctrl+K | Search projects and environments (sidebar) | the window's shell |
| ⌘⇧/ / Ctrl+Shift+/ (⌘? / Ctrl+?) | The keyboard shortcuts dialog | the focused app document (the window's renderer) |
| ⌘, / Ctrl+, | Global settings (`GlobalSettingsHost`) | the window's shell |
| ⌘T / Ctrl+T | A new agent tab, except while environment setup runs | the workspace on show (the command node's or another node's) |
| ⌘⇧D / Ctrl+Shift+D | Rotate the sidebar's group-by mode ([order](federation.md#compact-sidebar)) | the window's shell |

Either modifier is accepted on every platform, but not both, and not with Alt.
Plain Ctrl+T stays with a shell or a macOS text field, where it transposes
characters; ⌘T is always the app's. A browser-served client cannot have ⌘T: the
browser opens its own tab before the page sees the key.

| Piece | File |
| --- | --- |
| App-level shortcut list, matcher, claim rule, events | `packages/protocol/src/keyboard-shortcuts.ts` (`APP_SHORTCUTS`) |
| Renderer key router and delivery | `apps/web/src/lib/app-shortcuts.ts` (retained by `AppShell` and by each handler) |
| Catalog the dialog lists | `apps/web/src/lib/keyboard-shortcuts.ts` (app-level entries take their keys from `APP_SHORTCUTS`) |
| Search | `apps/web/src/components/sidebar/ProjectSearchBar.tsx` |
| Dialog | `apps/web/src/components/layout/KeyboardShortcutsDialog.tsx` (mounted once per renderer by `AppShell`) |
| Settings | `apps/web/src/components/layout/GlobalSettingsHost.tsx` (mounted once per renderer by `AppShell`) |
| Sidebar group-by rotation | `apps/web/src/components/sidebar/HierarchicalSidebar.tsx`, `apps/web/src/lib/federation/sidebar-grouping.ts` |
| Which workspace a workspace-owned shortcut acts on | `onAppShortcut(id, handler, { workspace: scope })`, `setShownAppShortcutWorkspace` in `apps/web/src/lib/app-shortcuts.ts` |
| Design frame relay | `packages/protocol/src/design-runtime.ts`, `apps/web/src/components/design/frame-bridge.ts` |
| View › Keyboard Shortcuts… and Settings… menu items | `apps/desktop/electron/application-menu.ts` |
| Native input wiring and remembered menu focus | `apps/desktop/electron/keyboard-shortcuts-routing.ts` |
| Native ownership, focus restoration, `requestAppShortcut` | `apps/desktop/electron/keyboard-shortcuts-menu.ts` |

To add an app-level shortcut, add it to `APP_SHORTCUTS`, add its handler with
`onAppShortcut(id, …)` in the component that owns its UI, and add its catalog
entry with `appShortcutEntry`. Every router reads `APP_SHORTCUTS`, and a unit
test fails if the catalog's app-level entries and `APP_SHORTCUTS` disagree.
The handlers for local shortcuts live next to the surfaces that own them; the
catalog only describes them. Update the catalog when adding or changing one.

## One routing path

Every key press of an app-level shortcut ends in `requestAppShortcut(id)` in
some app document, which delivers it to the owner:

- Another node's workspace is in the window's own document, on its node
  scope (plan item 5003), so a key typed there reaches the window's router
  and handlers directly. A **workspace-owned** shortcut (⌘T) runs only the
  handlers of the workspace on show: each handler names its workspace
  (`onAppShortcut(id, handler, { workspace: scope })`) and the window says
  which one it shows (`setShownAppShortcutWorkspace`). The command node's
  workspace stays mounted, hidden, while another node's is shown, so without
  this its handler would run too.
- The document's handlers run. If none is mounted (the sidebar is
  hidden), the window shows the sidebar and the request waits for the search
  to mount. The phone layout's drawer stays closed and the request is
  dropped, so it never opens later by surprise. The compact sidebar has no
  search, so there ⌘K is dropped too, hidden or not.

The key press reaches `requestAppShortcut` from one of these entry points:

1. **App documents (the window's renderer, desktop and browser).** A capture-phase
   `keydown` listener on `window` matches `APP_SHORTCUTS`, applies the claim
   rule below, then calls `preventDefault` and `stopPropagation` before Monaco,
   xterm or the composer can handle the key. Repeats are consumed without a
   second toggle.
2. **Design frames.** The sandboxed runtime is serialized with the matcher,
   `APP_SHORTCUTS`, and the shared focus classifier and claim rule. It applies
   the platform/text-editing exception before consuming or forwarding a key
   over the source-checked frame bridge.
3. **Desktop main, `before-input-event` on every WebContents.**
   - ⌘⇧/ (document-owned): consumed before page and menu dispatch in every app
     renderer and artifact view, including their subframes, and
     delivered as `menu-keyboard-shortcuts` `toggle`. Browser and service
     preview views use their preview manager's hook, which matches the catalog
     and routes entries whose `fromPreviews` flag is enabled.
   - ⌘K (window-owned): consumed only in native **artifact** views, which run
     no router, and delivered to the window's shell renderer as
     `app-shortcut` after focusing it. In an app document main leaves it to
     the DOM router (point 1), which knows what has focus. In a browser
     preview it stays with the page (see Decisions). Native artifacts have no
     trusted focus classifier, so on macOS plain Ctrl+K stays with the whole
     artifact surface to preserve text editing; Cmd+K still opens search.

Only `keyDown` triggers; `rawKeyDown` is not a second delivery. The Electron
API documents this event as `keyDown`/`keyUp`.

**Layouts:** a printable ASCII `event.key` decides, preserving Dvorak
mappings and AZERTY's `,` on the M key. For anything else (Cyrillic, Greek, a
control character) the physical position (`KeyK`, `Comma`, `Slash`) decides.
`?` counts as `/`: it is the shifted `/` on US, UK and most Latin layouts, and
a shifted chord may report either (macOS reports `/` for ⌘⇧/; browsers report
`?` for Ctrl+Shift+/). On a layout where `/` itself needs Shift (German's
Shift+7), that key with ⌘ or Ctrl opens the dialog.

## What a focused surface keeps

`appClaimsShortcut` decides, from the platform and the kind of focused surface
(`shortcutFocus`: terminal, text field, or page), whether the app takes the
key:

| Focus | ⌘K | Ctrl+K on macOS | Ctrl+K on Windows/Linux | ⌘⇧/ / Ctrl+Shift+/ |
| --- | --- | --- | --- | --- |
| Page (sidebar, buttons, panes) | search | search | search | dialog |
| Text field (composer, inputs, contenteditable, Monaco) | search | kill-line (text field) | search | dialog |
| Terminal (xterm) | search | kill-line (shell) | kill-line (shell) | dialog |

## Decisions

- **⌘K works in text fields, the composer included.** Previously ⌘K was
  ignored in any text field, so it did nothing from the composer, the most
  common place focus sits in the main area. ⌘K edits no text on any platform.
  The alternative, keeping text fields exempt, keeps "type K freely" safety
  that ⌘K never needed and is the reported bug.
- **Plain Ctrl+K stays with terminals everywhere and with text fields on
  macOS.** Ctrl+K is kill-line in readline, zsh and nano, and in Cocoa text
  fields. Taking it would delete a real editing key. The cost is that macOS
  users coming from another platform get Ctrl+K search only outside text
  fields, and Windows/Linux users get no Ctrl+K search from a terminal (the
  Windows/Linux composer still takes Ctrl+K as search).
- **⌘K in a focused terminal opens search, it does not clear.** Orkestrator
  never bound ⌘K to clear, xterm sends nothing for ⌘K, and the terminals are
  tmux-backed, where clearing xterm's buffer is undone by tmux's next redraw.
  Clear-on-⌘K (iTerm, VS Code) would need a tmux `clear-history` round trip and
  would make ⌘K mean different things in different panes. Ctrl+K and the
  shell's `clear` remain.
- **⌘K in Monaco opens search.** Monaco uses ⌘K as a chord prefix (⌘K ⌘C,
  ⌘K ⌘0). The editor here is for quick file edits, and those commands remain
  in its command palette (F1). Uniform search wins over chords few users rely
  on in this editor. On macOS, Ctrl+K stays with Monaco, as with any text
  field.
- **⌘K stays with pages in a browser preview; ⌘⇧/ does not.** The previewed
  page is the user's own product, and ⌘K is the web's usual command-palette
  key. Stealing it would break testing that page, as no real browser does.
  ⌘⇧/ is rare on the web and is the app's escape hatch. Click outside the
  preview to use ⌘K. (`AppShortcut.fromPreviews`.)
- **⌘⇧/ opens the focused document's dialog, ⌘K the window's search.** Each
  app document renders its own dialog, which restores focus into its native
  preview and artifact views; that path is already tested. The search lives
  in the window's sidebar. Since every node's workspace is in the window's
  document, the document and the window are the same renderer; the owner
  values (`AppShortcut.owner`) still differ for artifact views, which run no
  router.
- **⌘, opens Settings everywhere, previews included, and never toggles.** It
  is every Mac app's settings key, edits no text (`ctrlEditsText: false`), and
  web pages rarely bind it. Settings are window-owned like search: they are
  the command node's, whichever node's workspace is shown. A repeat while
  Settings are open leaves them on the section shown.
- **⌘⇧D rotates the sidebar's group-by mode.** ⌘⇧G came first but is the
  run-script dialog on macOS, and because either modifier is accepted everywhere,
  Ctrl+Shift+G would be taken with it. ⌘⇧L is Monaco's select-all-occurrences.
  ⌘⇧D is bound by nothing in the app, Monaco, Tiptap or the desktop menus; a
  browser's bookmark-all-tabs gives way to `preventDefault`. It edits no text
  (`ctrlEditsText: false`), so like the other app-level shortcuts it works from
  text fields and terminals. It stays with a previewed page
  (`fromPreviews: false`), and taking it there would also move keyboard focus out
  of the page. Window-owned. With the sidebar hidden it shows the sidebar and
  rotates.
- **Ctrl+Shift+/ opens the dialog on macOS too.** Users coming from another
  platform press it, and Ctrl+Shift+/ edits nothing there.
- **⌘⇧/ rather than ⌘⇧K.** On some Macs ⌘⇧K and Ctrl+Shift+K were swallowed
  before any app saw them, so the dialog was unreachable from the keyboard
  there. ⌘? is also the help key many apps use. The macOS app menu has no Help
  menu, so AppKit's ⌘? Help search does not compete for it.
- **An app document's DOM router, not main, routes ⌘K there.** Main cannot
  see whether a terminal or text field has focus, so catching ⌘K in main for
  every WebContents (the ⌘⇧/ design) would take Ctrl+K from shells. Main
  catches window-owned shortcuts only where no router runs (artifact views).

## Menu and press ownership

Main focuses the owning renderer and emits `menu-keyboard-shortcuts` with an
`open` request for a menu click or `toggle` for a chord. Clicking while open
keeps the dialog, its search text and focus. The item displays
`CmdOrCtrl+Shift+/` with `registerAccelerator: false`; macOS retains a menu key
equivalent as a fallback. Native input interception prevents page/menu double
handling. The renderer's router remains available for browser and synthetic
input, but physical input consumed by main never reaches it.
There is no elapsed-time echo window: a distinct second press always toggles.

Settings… (macOS app menu, after Check for Updates…; File on Windows and Linux)
displays `CmdOrCtrl+,` with `registerAccelerator: false` too. Its click sends
the `open-settings` app shortcut to the focused window's shell renderer over
`app-shortcut`, the path ⌘, typed in an artifact view takes. The key itself is
the app routers' (point 1 and 3 above); macOS keeps the menu's key equivalent
for a press no page claimed. Opening is idempotent, so no delivery can close
Settings.

Electron distinguishes the template callback (`click(menuItem, window, event)`)
from the built item's method (`menuItem.click(event, window, webContents)`).
The latter adapts the event into the callback's third argument. E2E helpers use
that event-first method and assert an accelerator click closes an already-open
dialog, so an accidental `open` request cannot pass. See Electron's
[MenuItem API](https://www.electronjs.org/docs/latest/api/menu-item).
Electron also sets `triggeredByAccelerator` for Enter-based native menu
navigation. The callback checks Shift and the platform's Ctrl/Command modifier
as well, so selecting the item with the keyboard keeps an open dialog open.

## Windows and Linux

The dialog reads `navigator.platform` (falling back to the user agent): macOS
and iOS show ⌘ caps, and everything else, Windows and Linux included, shows
`Ctrl`, `Shift` and `Alt` caps and hides the ⌘-only rows. The catalog test
rejects macOS symbols in any Windows/Linux key cap.

The chord also accepts Super/Windows+Shift+/, because Chromium reports that key
as `metaKey`. The dialog documents Ctrl+Shift+/ because window managers and
Windows often take Super shortcuts first. AltGr reaches Chromium on Windows as
Ctrl+Alt, so the chord's Alt exclusion leaves AltGr+Shift+/ to the focused
field.

`createApplicationMenuTemplate` takes `process.platform`. Electron maps the
`Command` accelerator modifier to Super/Windows outside macOS, and the `hide`,
`hideOthers`, `unhide` and `zoom` roles do nothing there. Windows and Linux
therefore get their conventional layout:

| macOS | Windows and Linux |
| --- | --- |
| App menu: About, Check for Updates…, Settings…, Hide, Hide Others, Show All, Quit | No app menu. Settings… then Quit (Windows: Exit) end File. Help holds Check for Updates… and About |
| File › Close Tab `Command+W` | File › Close Tab with no accelerator |
| Window › Minimize, Zoom, open windows | Window › Minimize, open windows |

Windows/Linux Close Tab has no key, and the catalog lists it as macOS-only; on
every platform, Delete closes the tab focused in an environment's tab strip.
`Command+W` would register Super/Windows+W, which window managers and Windows
own. Ctrl+W is the shell's delete-word. The renderer's ⌘W fallback for the
browser client still sees Super+W as `metaKey`. New Window, the zoom items and
Keyboard Shortcuts… use `CmdOrCtrl` and appear as Ctrl+N, Ctrl+=, Ctrl+- and
Ctrl+0 (all registered) and Ctrl+Shift+/ and Ctrl+, (display-only). The dialog lists the
same keys.

**Native children:** ownership is resolved from the actual focused
WebContents, including a window's preview and artifact children (another
node's previews are children of the same window). Menu clicks reach that
window's dialog even while its renderer itself has no native focus. The
last focused child is retained per window for native menu activation that
temporarily clears WebContents focus.

## Returning to a native view

Before focusing the renderer, main retains the originating preview or artifact
view for that renderer. The preload reports dialog dismissal after DOM focus
restoration. Main waits up to 500 ms for overlay visibility IPC to show the
original native view, then focuses it only if it is still live and visible and
the owning window and renderer still have focus. Hidden, replaced or disposed
views never receive focus. New requests cancel a pending restoration timer but
retain its native origin, including when reopening during visibility retries.
The final dismissal restores once; success, expiry, navigation or renderer
destruction clears retained origins. Renderer-originated opens retain the
existing DOM focus restoration.

The search does not return native focus to a preview or artifact it was
opened from: closing it leaves focus in the window.

**A hidden preview never keeps keyboard focus.** Electron focuses a view's
WebContents when it loads a URL, whether or not the view is shown. A
background tab's browser preview loads in a hidden view, so opening an
environment whose layout holds one used to move native focus to that
invisible page: the composer on show kept its caret, but typing went nowhere
(found by the packaged Linux run, 2026-11-11). `BrowserPreviewManager` now
answers a hidden or zero-sized preview's `focus` event by focusing the
window's own renderer one task later (focusing inside the event has no
effect), if the hidden preview still has focus then. Electron's
`WebContents.focus()` also focuses the owner window on macOS and Linux, so
while the window is in the background the manager does not focus anything: it
waits for the window's next `focus` event and checks again then, so a page
loading in a background tab never raises Orkestrator over another app. A
shown preview keeps the focus it is given.

**A design frame returns focus to its field.** While the dialog has focus,
Chromium leaves a design frame with no focused element, and the dialog's
close restores focus to the frame's `<iframe>`, not to the field inside it.
The design runtime remembers the element that last took focus in the frame
and, when the frame regains focus with nothing focused, focuses it again
(skipped once it has left the document). A click or Tab into the frame moves
focus after this runs, so it still decides where focus lands.

## Browser-client limits

The parent document cannot intercept keys in uncooperative cross-origin
browser/service preview iframes or artifact shells (the artifact shell is
served from its own origin). Move focus to the host UI to use either shortcut.
The browser test covers the preview boundary explicitly; desktop handles
⌘⇧/ there through native interception. A browser may also reserve the
chord before the page sees it: on macOS, browsers with a Help menu may keep
⌘⇧/ (⌘?) for its search field. This has not been verified here; Ctrl+Shift+/
is the fallback on macOS.

## Tests

- Protocol: matcher on both modifiers and layouts, catalog reachability, and
  the claim table for each platform and focus; serialized design bootstraps
  before and after production minification, including macOS text editing; a
  design frame regaining focus with nothing focused returns it to its last
  field (`design-runtime.test.ts`).
- Renderer: the router from composer, terminal and contenteditable on macOS
  and Windows, a workspace shortcut reaching only the workspace on show,
  main's `app-shortcut` event, pending delivery; the search from the composer, a terminal and text
  fields; the dialog with ⌘⇧/ and Ctrl+Shift+/ on both platforms; the design
  frame bridge; router reference counting and final DOM/native listener
  cleanup; AppShell revealing the hidden desktop sidebar and delivering search
  once, and dropping closed mobile-drawer requests.
- Electron main: ⌘K and non-macOS Ctrl+K from an artifact view reach the window's
  shell, macOS artifact Ctrl+K stays with the surface; preview routing follows
  `fromPreviews`; app documents, previews and unknown contents keep unclaimed
  keys; Ctrl+Shift+/ toggles like ⌘⇧/; ⌘, and Ctrl+, from an artifact view reach the
  window's shell on macOS and Linux. A hidden or zero-sized browser preview
  that takes focus hands it back to the window's renderer one task later, and
  a shown one keeps it (`browser-preview-manager.test.ts`).
- Settings: `GlobalSettingsHost.test.tsx` (⌘,, Ctrl+, and the menu's request open
  Settings and leave an open page where it is), the menu template on all three
  platforms, and the mobile drawer giving way to Settings and the bug report sheet.
- Browser fixture (`e2e/KeyboardShortcuts.spec.ts`): ⌘K from the composer,
  Ctrl+K reaching xterm's shell, ⌘K from a design frame, shortcuts from a
  leaf's composer reaching this window's handlers; real search above fullscreen settings and the shortcuts dialog,
  including pointer input, typing, the portalled filter menu, and Escape at
  desktop and phone widths.
- Additional unit coverage checks Close Tab and shortcut ownership with live or cleared
  WebContents focus, per-window remembered focus, dismissal sender gating, preview
  hook delegation, repeat consumption, reopen/restoration races and expiry.
  Additional checks cover dismissal, disposal, hidden views, startup
  forwarding, keyDown/rawKeyDown and immediate second presses. Electron scenarios
  cover a window's preview ownership, search focus and restored typing after keyboard
  and outside-pointer dismissal, accelerator toggles on already-open dialogs, artifact
  subframes, and design subframes. Windows/Linux coverage includes the menu
  layout and accelerators on `linux` and `win32`, Ctrl and AltGr Electron input,
  platform detection, and Ctrl key caps.

Packaged native OS qualification is recorded under
[Packaged native qualification](#packaged-native-qualification).

`e2e/agent-testing/application-menu-electron.spec.ts` builds the production
template in a disposable Electron process, checks resolved role labels and
accelerators, and invokes the built menu callbacks. With
`ORKESTRATOR_NATIVE_MENU_INPUT=1` on an isolated desktop, it also uses OS input
to navigate View, checks repeated selection, accelerator registration,
the real About panel, and resumed typing. The native-menu workflow runs this
on Linux/Xvfb and Windows and retains menu defaults and About screenshots.

## Packaged native qualification

Electron specs that use Chromium input exercise `before-input-event` but not
the operating system's own key handling. These checks press real keys (X11
XTEST through `xdotool`) in a packaged build.

**Linux, X11 (Xvfb, no window manager, US layout).** On 2026-10-31 a packaged
build of `931e5541` passed the sidebar, terminal and Monaco rows (Ctrl+Shift+/
opens, a separate press closes, Escape closes, typing resumes; Ctrl+K opens
search from the sidebar and Monaco and reaches the shell from a terminal;
Ctrl+Shift+K deletes Monaco's line without the dialog) and the whole menu-bar
row (File, Edit, View, Window and Help with no macOS-only item; View ›
Keyboard Shortcuts… shows `Ctrl+Shift+/` and opens from Alt, Right, Right,
Down, End, Enter; choosing it again keeps the dialog; Close Tab has no key;
Super+H does nothing; Ctrl+Q quits; Help › About opens). On 2026-11-11
`e2e/agent-testing/packaged-native-shortcuts-electron.spec.ts` passed five
repetitions out of five on a packaged linux-arm64 build of `498b68766` (2.37.5-beta,
Electron 45.2.3) for the remaining surfaces, with the hidden-preview and
design-frame focus fixes under [Returning to a native view](#returning-to-a-native-view)
in place (without them the composer and design-frame rows failed). Every row also types afterwards and checks the keys arrived:

| Surface | Checked |
| --- | --- |
| Composer (an unassigned agent tab) | Ctrl+Shift+/ opens with search focused and a separate press closes; Escape closes; Ctrl+K opens the window's search, which takes typing; a background browser tab's hidden preview loads without taking focus from it |
| Browser preview | Ctrl+Shift+/ opens and a separate press closes; Escape and an outside pointer click close; View › Keyboard Shortcuts… from the keyboard opens it, and choosing it again keeps it open and refocuses search; typing resumes in the page's field after each; Ctrl+K stays with the page |
| Interactive artifact view | Ctrl+Shift+/ opens and a separate press or Escape closes, typing resumes in the artifact's field; Ctrl+K opens the window's search |
| Design frame (a field in the frame) | Ctrl+Shift+/ opens and a separate press or Escape closes, typing resumes in the field; Ctrl+K opens the window's search |

The spec is opt-in and skips unless `ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1`. Run
it only on a disposable X display, because the keys go to whichever window has
X focus. It needs `xdotool`, `setxkbmap`, ImageMagick's `import` and, for
design workspaces, a Chromium the backend can find (`/usr/bin/chromium` or
`ORKESTRATOR_DESIGN_CHROMIUM_PATH`). The app runs on a disposable agent-test
profile with gateway port 0 and starts no agent; the artifact is served by the
test's own `LoopbackArtifactContentServer` and the preview page by a loopback
server. The 2026-11-11 run used a Debian trixie arm64 Docker container on a Mac
holding the source tree, Xvfb and those tools, so nothing ran on the host's
desktop:

```bash
mise run package:linux:unpacked:test
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
DISPLAY=:99 ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1 \
mise run test:logged -- --name packaged-native-shortcuts -- \
  bunx playwright test --config e2e/agent-testing/playwright.packaged-electron.config.ts \
  packaged-native-shortcuts-electron.spec.ts
```

The run gives the window X focus itself (there is no window manager) and puts
DOM focus on each surface before its first press, as a click would. It does
not cover Wayland, input methods or a window manager's focus policy.

**Still owed, by a person** (items in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)):
the matrix below on a packaged macOS build, with a Cyrillic input source;
the same matrix on a Linux Wayland desktop; and the macOS About panel. Record
per row the OS and display server or compositor, packaged commit, keyboard
layout or input source, surface, the separate-press result and the
resumed-typing result.

- ⌘⇧/ (Ctrl+Shift+/ on Linux) with focus in the sidebar, composer, terminal,
  Monaco, browser/service preview, interactive artifact and design frame: one
  press opens, an immediate separate press closes.
- View › Keyboard Shortcuts… opens the dialog in the window's renderer while a
  preview has focus; choosing it again keeps the dialog and refocuses search.
- A dialog opened from a preview closes with Escape, the chord and an outside
  pointer click, and typing resumes in that preview. Hidden or disposed
  previews never regain focus.
- With Monaco focused, ⌘⇧K (Ctrl+Shift+K on Linux) deletes the current line
  without opening the dialog, and typing stays in the editor.
- Linux only, the in-window menu bar: the row recorded above for X11.
- ⌘K from the sidebar, composer, Monaco, an interactive artifact and a design
  frame opens the window's search, which takes typing; Ctrl+K does the same on
  Linux. On macOS, Ctrl+K stays with a focused text field (composer, Monaco, a
  design frame's input) and with an interactive artifact. In a terminal Ctrl+K
  reaches the shell and ⌘K opens search. In a browser preview ⌘K stays with
  the page.
- macOS only, with a Cyrillic input source: ⌘⇧ and the physical `Slash` key
  open the dialog when it reports a non-ASCII character; on a layout that
  types ASCII the typed `/` or `?` wins, and a different ASCII character on
  `Slash` does not open it.

The to-do that tracked this, 0325, was retired on 2026-11-11 (read it with
`git show 498b68766:docs/todo/cross-cutting/0325-keyboard-shortcuts-desktop-gaps.md`).

## Terminal mouse selection

In both workspace terminals and Claude tmux terminals, macOS Option-drag selects
text locally even when tmux or a TUI has mouse reporting enabled. On other
platforms, Shift-drag bypasses mouse reporting. Unmodified drags still reach the
running program when it requests mouse reporting.

We deliberately enable xterm's `macOptionClickForcesSelection` at construction:
Option-drag uses linear selection, including in a plain shell, instead of xterm's
rectangular column selection. We also disable `altClickMovesCursor` in both
constructors. Otherwise an Option-click or a very short Option-drag can synthesize
arrow keys and send them to the running program. This trades shell Alt-click
cursor positioning and macOS Option-drag column selection for a consistent local
selection gesture that sends no input. Tracking mouse modes to change these
options dynamically would preserve more shell gestures but adds lifecycle state
to both terminal implementations.

On macOS, the focused pane tab also accepts Backspace (the key labelled delete); Fn+Delete remains supported.
