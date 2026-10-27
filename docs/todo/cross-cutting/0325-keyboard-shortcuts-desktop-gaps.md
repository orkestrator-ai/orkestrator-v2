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
- Dismiss a preview-originated dialog with Escape and with the chord; typing
  resumes in that preview. Hidden or disposed previews never regain focus.
- With a Cyrillic input source on macOS, ⌘⇧ and the K key open the dialog.

The browser client cannot intercept keyboard events in uncooperative
cross-origin browser/service preview iframes. This origin-isolation limit has
an explicit browser regression test. App-owned design frames relay through a
source-checked bridge; desktop intercepts all these surfaces in native input.
