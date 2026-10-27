# Keyboard shortcuts dialog: native-key evidence and Linux gaps

Opened 2026-10-27 with the View › Keyboard Shortcuts… item and the native
preview forwarding ([keyboard-shortcuts.md](../../architecture/keyboard-shortcuts.md)).

## 1. Native key presses in a packaged build

Every automated check of the chord so far reaches the renderer through CDP
(Playwright) or synthetic DOM events, which skip AppKit's key-equivalent pass
and the Windows/Linux accelerator path. The macOS menu-versus-page order the
design relies on (the page sees a Command chord first, and `preventDefault()`
stops the menu's key equivalent) comes from Chromium's documented behaviour,
not from a recorded run.

Owed, on a packaged build (macOS, and one Linux desktop):

- ⌘⇧K / Ctrl+Shift+K with focus in the sidebar, the agent composer, a
  terminal, a Monaco editor, a browser tab's page, a service preview, the
  Multi Review and build tabs, a realm, and with nothing focused: one press
  opens, the next closes.
- View › Keyboard Shortcuts… by mouse: opens; again while open: stays open.
- With a Cyrillic input source on macOS: ⌘⇧ and the K key open the dialog.

If a platform turns out to deliver one press through both paths, the 500 ms
echo window keeps it to one toggle; record which path arrived first.

## 2. Linux: artifact views and design frames do not reach the dialog

`ArtifactHostSession` views are native web contents like browser previews, but
have no `before-input-event` hook, and design frames are iframes whose keys
never reach the renderer's listener. On macOS the menu's key equivalent covers
both (their page does not claim the chord); on Linux the accelerator is
display-only, so nothing toggles the dialog while one has focus. Add the same
forwarding as `BrowserPreviewManager` to artifact views (keeping the artifact
host's hardening review in mind), and decide whether a design frame should
relay the chord to its host.

Also record on a packaged macOS build that the menu's key equivalent does fire
from these surfaces.
