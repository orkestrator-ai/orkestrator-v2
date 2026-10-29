# Keyboard shortcuts

Two kinds of shortcut exist. **App-level** shortcuts belong to the
application and work wherever focus is in the window: the sidebar, the main
area, the composer, a terminal, Monaco, a leaf node's workspace realm, a design
frame or an interactive artifact. **Local** shortcuts belong to the surface
that owns them (the composer's Enter, a terminal's copy, the design canvas's
keys, ⌘T and the other environment keys) and work only while it has focus.

The app-level shortcuts are:

| Shortcut | Opens | Owner |
| --- | --- | --- |
| ⌘K / Ctrl+K | Search projects and environments (sidebar) | the window's shell |
| ⌘⇧K / Ctrl+Shift+K | The keyboard shortcuts dialog | the focused app document (shell or realm) |
| ⌘, / Ctrl+, | Global settings (`GlobalSettingsHost`) | the window's shell |

Either modifier is accepted on every platform, but not both, and not with Alt.

| Piece | File |
| --- | --- |
| App-level shortcut list, matcher, claim rule, events | `packages/protocol/src/keyboard-shortcuts.ts` (`APP_SHORTCUTS`) |
| Renderer key router and delivery | `apps/web/src/lib/app-shortcuts.ts` (retained by `AppShell` and by each handler) |
| Catalog the dialog lists | `apps/web/src/lib/keyboard-shortcuts.ts` (app-level entries take their keys from `APP_SHORTCUTS`) |
| Search | `apps/web/src/components/sidebar/ProjectSearchBar.tsx` |
| Dialog | `apps/web/src/components/layout/KeyboardShortcutsDialog.tsx` (mounted once per renderer by `AppShell`) |
| Settings | `apps/web/src/components/layout/GlobalSettingsHost.tsx` (mounted once per renderer by `AppShell`) |
| Realm → window message | `apps/web/src/lib/federation/workspace-realm.ts` (`{ type: "shortcut" }`), handled in `RemoteWorkspaceRegion.tsx` |
| Design frame relay | `packages/protocol/src/design-runtime.ts`, `apps/web/src/components/design/frame-bridge.ts` |
| View › Keyboard Shortcuts… and Settings… menu items | `apps/desktop/electron/application-menu.ts` |
| Native input wiring and remembered menu focus | `apps/desktop/electron/keyboard-shortcuts-routing.ts` |
| Native ownership, focus restoration, `requestAppShortcut` | `apps/desktop/electron/keyboard-shortcuts-menu.ts` |
| Realm → window focus handoff | `apps/desktop/electron/workspace-views.ts` (`post`) |

To add an app-level shortcut, add it to `APP_SHORTCUTS`, add its handler with
`onAppShortcut(id, …)` in the component that owns its UI, and add its catalog
entry with `appShortcutEntry`. Every router reads `APP_SHORTCUTS`, and a unit
test fails if the catalog's app-level entries and `APP_SHORTCUTS` disagree.
The handlers for local shortcuts live next to the surfaces that own them; the
catalog only describes them. Update the catalog when adding or changing one.

## One routing path

Every key press of an app-level shortcut ends in `requestAppShortcut(id)` in
some app document, which delivers it to the owner:

- A **window-owned** shortcut (⌘K) typed in a workspace realm crosses to the
  window over the existing realm message channel (`postToShell`): on the
  desktop through main (`WorkspaceViews.post`, which also gives the window's
  renderer native keyboard focus), in a browser as a same-origin
  `postMessage` in the realm's frame envelope. The window's
  `RemoteWorkspaceRegion` hands it to its own `requestAppShortcut`.
- Otherwise the document's handlers run. If none is mounted (the sidebar is
  hidden), the window shows the sidebar and the request waits for the search
  to mount. The phone layout's drawer stays closed and the request is
  dropped, so it never opens later by surprise.

The key press reaches `requestAppShortcut` from one of these entry points:

1. **App documents (shell and realm, desktop and browser).** A capture-phase
   `keydown` listener on `window` matches `APP_SHORTCUTS`, applies the claim
   rule below, then calls `preventDefault` and `stopPropagation` before Monaco,
   xterm or the composer can handle the key. Repeats are consumed without a
   second toggle.
2. **Design frames.** The sandboxed runtime is serialized with the matcher,
   `APP_SHORTCUTS`, and the shared focus classifier and claim rule. It applies
   the platform/text-editing exception before consuming or forwarding a key
   over the source-checked frame bridge.
3. **Desktop main, `before-input-event` on every WebContents.**
   - ⌘⇧K (document-owned): consumed before page and menu dispatch in every app
     renderer, realm and artifact view, including their subframes, and
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
control character) the physical position (`KeyK`, `Comma`) decides.

## What a focused surface keeps

`appClaimsShortcut` decides, from the platform and the kind of focused surface
(`shortcutFocus`: terminal, text field, or page), whether the app takes the
key:

| Focus | ⌘K | Ctrl+K on macOS | Ctrl+K on Windows/Linux | ⌘⇧K / Ctrl+Shift+K |
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
- **⌘K stays with pages in a browser preview; ⌘⇧K does not.** The previewed
  page is the user's own product, and ⌘K is the web's usual command-palette
  key. Stealing it would break testing that page, as no real browser does.
  ⌘⇧K is rare on the web and is the app's escape hatch. Click outside the
  preview to use ⌘K. (`AppShortcut.fromPreviews`.)
- **⌘⇧K opens the focused realm's dialog, ⌘K the window's search.** Each app
  document renders its own dialog, which restores focus into that realm's
  native preview and artifact views; that path is already tested. The search
  lives in the window's sidebar; a realm has none. (`AppShortcut.owner`.)
- **⌘, opens Settings everywhere, previews included, and never toggles.** It
  is every Mac app's settings key, edits no text (`ctrlEditsText: false`), and
  web pages rarely bind it. Settings are window-owned like search: a realm
  forwards ⌘, to its window, whose command node owns them. A repeat while
  Settings are open leaves them on the section shown.
- **Ctrl+Shift+K opens the dialog on macOS too.** Users coming from another
  platform press it, and Ctrl+Shift+K edits nothing there.
- **An app document's DOM router, not main, routes ⌘K there.** Main cannot
  see whether a terminal or text field has focus, so catching ⌘K in main for
  every WebContents (the ⌘⇧K design) would take Ctrl+K from shells. Main
  catches window-owned shortcuts only where no router runs (artifact views).
  The realm-to-window hop reuses the realm message channel on both platforms,
  so desktop and browser realms share one path.

## Menu and press ownership

Main focuses the owning renderer and emits `menu-keyboard-shortcuts` with an
`open` request for a menu click or `toggle` for a chord. Clicking while open
keeps the dialog, its search text and focus. The item displays
`CmdOrCtrl+Shift+K` with `registerAccelerator: false`; macOS retains a menu key
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
| App menu: About, Check for Updates…, Settings…, Hide, Hide Others, Show All, Quit | No app menu. Settings… then Quit (Windows: Exit) end File. Help holds Check for Updates… and About |
| File › Close Tab `Command+W` | File › Close Tab with no accelerator |
| Window › Minimize, Zoom, open windows | Window › Minimize, open windows |

Windows/Linux Close Tab has no key, and the catalog lists it as macOS-only.
`Command+W` would register Super/Windows+W, which window managers and Windows
own. Ctrl+W is the shell's delete-word. The renderer's ⌘W fallback for the
browser client still sees Super+W as `metaKey`. New Window, the zoom items and
Keyboard Shortcuts… use `CmdOrCtrl` and appear as Ctrl+N, Ctrl+=, Ctrl+- and
Ctrl+0 (all registered) and Ctrl+Shift+K and Ctrl+, (display-only). The dialog lists the
same keys.

**Workspace realms:** ownership is resolved from the actual focused
WebContents, including its preview and artifact children. Menu clicks reach
that realm's dialog even while its renderer itself has no native focus. The
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

The search does not return native focus to a realm or artifact it was opened
from: closing it leaves focus in the window.

## Browser-client limits

The parent document cannot intercept keys in uncooperative cross-origin
browser/service preview iframes or artifact shells (the artifact shell is
served from its own origin). Move focus to the host UI to use either shortcut.
The browser test covers the preview boundary explicitly; desktop handles
⌘⇧K there through native interception. A browser may also reserve
Ctrl+Shift+K itself before the page sees it (Firefox uses it for the Web
Console, Edge for Duplicate Tab); this has not been verified here.

## Tests

- Protocol: matcher on both modifiers and layouts, catalog reachability, and
  the claim table for each platform and focus; serialized design bootstraps
  before and after production minification, including macOS text editing.
- Renderer: the router from composer, terminal and contenteditable on macOS
  and Windows, desktop and browser realm forwarding, main's `app-shortcut`
  event, pending delivery; the search from the composer, a terminal and text
  fields; the dialog with ⌘⇧K and Ctrl+Shift+K on both platforms; the design
  frame bridge; a realm's forwarded message reaching the window; router reference
  counting and final DOM/native listener cleanup; AppShell revealing the hidden
  desktop sidebar and delivering search once, dropping closed mobile-drawer
  requests, and skipping the shell fallback in a realm.
- Electron main: ⌘K and non-macOS Ctrl+K from an artifact view reach the window's
  shell, macOS artifact Ctrl+K stays with the surface; preview routing follows
  `fromPreviews`; app documents, previews and unknown contents keep unclaimed
  keys; Ctrl+Shift+K toggles like ⌘⇧K; ⌘, and Ctrl+, from an artifact view reach the
  window's shell on macOS and Linux; a visible realm's `shortcut` message focuses its window.
- Settings: `GlobalSettingsHost.test.tsx` (⌘,, Ctrl+, and the menu's request open
  Settings and leave an open page where it is), the menu template on all three
  platforms, and the mobile drawer giving way to Settings and the bug report sheet.
- Browser fixture (`e2e/KeyboardShortcuts.spec.ts`): ⌘K from the composer,
  Ctrl+K reaching xterm's shell, ⌘K from a design frame and from a same-origin
  realm frame; real search above fullscreen settings and the shortcuts dialog,
  including pointer input, typing, the portalled filter menu, and Escape at
  desktop and phone widths.
- Electron scenario (`workspace-realm-electron.spec.ts`): ⌘K in a realm's
  composer opens the window's search.
- Additional unit coverage checks Close Tab and shortcut ownership with live or cleared
  WebContents focus, per-window remembered focus, dismissal sender gating, preview
  hook delegation, repeat consumption, reopen/restoration races and expiry.
  Additional checks cover dismissal, disposal, hidden views, startup
  forwarding, keyDown/rawKeyDown and immediate second presses. Electron scenarios
  cover realm preview ownership, search focus and restored typing after keyboard
  and outside-pointer dismissal, accelerator toggles on already-open dialogs, artifact
  subframes, and design subframes. Windows/Linux coverage includes the menu
  layout and accelerators on `linux` and `win32`, Ctrl and AltGr Electron input,
  platform detection, and Ctrl key caps.

Packaged native OS qualification remains in
[0325](../todo/cross-cutting/0325-keyboard-shortcuts-desktop-gaps.md).

`e2e/agent-testing/application-menu-electron.spec.ts` builds the production
template in a disposable Electron process, checks resolved role labels and
accelerators, and invokes the built menu callbacks. With
`ORKESTRATOR_NATIVE_MENU_INPUT=1` on an isolated desktop, it also uses OS input
to navigate View, checks repeated selection, accelerator registration,
the real About panel, and resumed typing. The native-menu workflow runs this
on Linux/Xvfb and Windows and retains menu defaults and About screenshots.
