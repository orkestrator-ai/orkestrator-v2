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
- ⌘K / Ctrl+K with focus in the sidebar, composer, Monaco, an interactive
  artifact, a design frame and a workspace realm opens the window's search,
  which takes typing; in a terminal Ctrl+K still reaches the shell (kill-line)
  and ⌘K opens search; in a browser preview ⌘K stays with the page.

The browser client cannot intercept keyboard events in uncooperative
cross-origin browser/service preview iframes. This origin-isolation limit has
an explicit browser regression test. App-owned design frames relay through a
source-checked bridge; desktop intercepts all these surfaces in native input.

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
