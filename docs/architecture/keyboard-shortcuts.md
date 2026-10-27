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
| Main → renderer request, native preview chord | `apps/desktop/electron/keyboard-shortcuts-menu.ts` |

The handlers for other shortcuts live next to the surfaces that own them; the
catalog only describes them. Update the catalog when you add, change or remove
one.

## Who sees the key

- **The renderer owns the chord.** A capture-phase `keydown` listener on
  `window` runs before every element, document and bubble listener in that
  document, so the sidebar, the composer, xterm, Monaco and every tab see
  nothing of it. It calls `preventDefault()`, which also stops the macOS menu
  key equivalent from firing for the same press. The terminals' custom key
  handlers return `false` for the chord so xterm does not consume it either.
- **Layouts.** `event.key` decides when it is a Latin letter (so Dvorak's K is
  the key that types K). A layout that types no Latin letter there (Cyrillic,
  Greek, Hebrew) reports its own character, so the physical `KeyK` decides.
- **Native preview views** (desktop browser and service tabs) are separate web
  contents; their keys never reach the renderer. `BrowserPreviewManager`
  claims the chord in `before-input-event` (which also hides it from the page
  and the menu) and main sends a `toggle` request to the owning renderer, a
  realm's when the preview belongs to one, after focusing that renderer.
- **Workspace realms** are renderers of their own with their own dialog.
- **Iframes and other native views** (design frames, the browser client's
  browser tabs and artifacts, desktop interactive artifact views) keep their
  keys from the renderer's listener, and cross-origin content cannot be
  scripted. In the macOS desktop app the menu's key equivalent still fires for
  a press their page does not claim, and toggles the dialog. In the browser
  client and on Linux nothing does
  ([0325](../todo/cross-cutting/0325-keyboard-shortcuts-desktop-gaps.md)).

## The desktop View menu item

Main emits `menu-keyboard-shortcuts` to the focused window's focused renderer
(a realm if one has focus), focusing it first. The payload is a
`KeyboardShortcutsRequest`:

- `open` — a click. Shows the dialog; if it is already open it stays open,
  keeps its search text, and the search takes focus. A click never closes it.
- `toggle` — the chord, delivered by the menu's key equivalent or forwarded
  from a native preview view. Behaves like the key pressed in the renderer.

The item shows `CmdOrCtrl+Shift+K` with `registerAccelerator: false`. On
Windows and Linux that makes it display-only, so the renderer's own handler
(the one the browser client also uses) is the only owner of the key there. On
macOS the option is ignored and the item stays a key equivalent; it fires only
for a press that no page claimed.

One physical press must never both open and close the dialog. If a platform
ever delivers the same press through both the renderer and the menu, the
dialog takes a delivery from the other path within 500 ms
(`KEYBOARD_SHORTCUTS_ECHO_MS`) as the same press and ignores it.

The browser client has no native menu and never receives the event; the
keyboard path is unchanged there.
