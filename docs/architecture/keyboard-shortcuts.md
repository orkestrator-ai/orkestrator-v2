# Keyboard shortcuts dialog

The searchable list of application shortcuts. ⌘⇧K on macOS, Ctrl+Shift+K
elsewhere (either modifier is accepted, as with ⌘K) toggles it; the desktop
app also has **View › Keyboard Shortcuts…**.

| Piece | File |
| --- | --- |
| Dialog and its listeners | `apps/web/src/components/layout/KeyboardShortcutsDialog.tsx` (mounted once per renderer by `AppShell`) |
| Catalog the dialog lists | `apps/web/src/lib/keyboard-shortcuts.ts` |
| Chord, menu event name and request kinds | `packages/protocol/src/keyboard-shortcuts.ts` |
| View menu item | `apps/desktop/electron/application-menu.ts` |
| Native input wiring and remembered menu focus | `apps/desktop/electron/keyboard-shortcuts-routing.ts` |
| Native ownership and focus restoration | `apps/desktop/electron/keyboard-shortcuts-menu.ts` |

The handlers for other shortcuts live next to the surfaces that own them; the
catalog only describes them. Update the catalog when adding or changing one.

## Who sees the key

- **Desktop:** main intercepts `before-input-event` in every registered app
  renderer and interactive artifact view. This also receives input destined for
  their subframes, including opaque design frames. Browser and service preview
  views use their preview manager's hook. All paths consume the chord before
  page and menu dispatch. Only `keyDown` toggles; repeats are consumed, and
  `rawKeyDown` is not a second delivery. The Electron API documents this event
  as `keyDown`/`keyUp`.
- **Browser client:** a capture-phase window listener claims the chord before
  the composer, terminal or Monaco. App-owned design sandboxes relay the chord
  through their existing source-checked frame bridge. Uncooperative cross-origin
  browser/service preview iframes cannot be intercepted by the parent document;
  move focus to the host UI to use the chord. The browser test covers this
  boundary explicitly. Desktop handles it through native interception.
- **Layouts:** a Latin `event.key` decides which letter is K, preserving Dvorak
  mappings. For non-Latin characters the physical `KeyK` position decides.
- **Workspace realms:** ownership is resolved from the actual focused
  WebContents, including its preview and artifact children. Menu clicks reach
  that realm's dialog even while its renderer itself has no native focus.
  The last focused child is retained per window for native menu activation
  that temporarily clears WebContents focus.

## Menu and press ownership

Main focuses the owning renderer and emits `menu-keyboard-shortcuts` with an
`open` request for a menu click or `toggle` for a chord. Clicking while open
keeps the dialog, its search text and focus. The item displays
`CmdOrCtrl+Shift+K` with `registerAccelerator: false`; macOS retains a menu key
equivalent as a fallback. Native input interception prevents page/menu double
handling. A renderer DOM listener remains available for browser and synthetic
input, but physical input consumed by main never reaches it.
There is no elapsed-time echo window: a distinct second press always toggles.

Electron distinguishes the template callback (`click(menuItem, window, event)`)
from the built item's method (`menuItem.click(event, window, webContents)`).
The latter adapts the event into the callback's third argument. E2E helpers use
that event-first method and assert an accelerator click closes an already-open
dialog, so an accidental `open` request cannot pass. See Electron's
[MenuItem API](https://www.electronjs.org/docs/latest/api/menu-item).

## Windows and Linux

The dialog reads `navigator.platform` (falling back to the user agent): macOS
and iOS show ⌘ caps, and everything else, Windows and Linux included, shows
`Ctrl`, `Shift` and `Alt` caps and hides the ⌘-only rows. The catalog test
rejects macOS symbols in any Windows/Linux key cap.

The chord also accepts Super/Windows+Shift+K, because Chromium reports that key
as `metaKey`. The dialog documents Ctrl+Shift+K because window managers and
Windows often take Super shortcuts first. AltGr reaches Chromium on Windows as
Ctrl+Alt, so the chord's Alt exclusion leaves AltGr+Shift+K to the focused
field.

`createApplicationMenuTemplate` takes `process.platform`. Electron maps the
`Command` accelerator modifier to Super/Windows outside macOS, and the `hide`,
`hideOthers`, `unhide` and `zoom` roles do nothing there. Windows and Linux
therefore get their conventional layout:

| macOS | Windows and Linux |
| --- | --- |
| App menu: About, Check for Updates…, Hide, Hide Others, Show All, Quit | No app menu. Quit (Windows: Exit) ends File. Help holds Check for Updates… and About |
| File › Close Tab `Command+W` | File › Close Tab with no accelerator |
| Window › Minimize, Zoom, open windows | Window › Minimize, open windows |

Windows/Linux Close Tab has no key, and the catalog lists it as macOS-only.
`Command+W` would register Super/Windows+W, which window managers and Windows
own. Ctrl+W is the shell's delete-word. The renderer's ⌘W fallback for the
browser client still sees Super+W as `metaKey`. New Window, the zoom items and
Keyboard Shortcuts… use `CmdOrCtrl` and appear as Ctrl+N, Ctrl+=, Ctrl+- and
Ctrl+0 (all registered) and Ctrl+Shift+K (display-only). The dialog lists the
same keys.

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

Unit coverage checks Close Tab and shortcut ownership with live or cleared
WebContents focus, per-window remembered focus, dismissal sender gating, preview
hook delegation, repeat consumption, reopen/restoration races and expiry.
Additional checks cover dismissal, disposal, hidden views, startup
forwarding, keyDown/rawKeyDown and immediate second presses. Electron scenarios
cover realm preview ownership, search focus and restored typing after keyboard
and outside-pointer dismissal, accelerator toggles on already-open dialogs, artifact
subframes, and design subframes. Windows/Linux coverage includes the menu
layout and accelerators on `linux` and `win32`, Ctrl and AltGr Electron input,
platform detection, and Ctrl key caps. Packaged native OS qualification remains in
[0325](../todo/cross-cutting/0325-keyboard-shortcuts-desktop-gaps.md).
