# Mobile layout gaps

Checked against `main` at `9906db30` (2026-10-16).

Below 768 px the renderer switches to a phone layout: a projects drawer instead
of the sidebar, and a pane switcher instead of resize handles. A window can
cross that breakpoint at any time, for example when it is narrowed, when a phone
rotates or when split-screen starts. Crossing it must not throw away UI state,
and every action has to stay reachable in the narrow layout. #988 fixed this for
the app shell, and stable per-pane hosts fixed it for split panes. The
environment settings gap remains, plus a follow-up for panes the switcher hides.

## Current state

- **Stable hosts.** Content that must survive a layout switch renders once,
  through a portal, into a host element its owner keeps. Each layout renders a
  `HostSlot` (`apps/web/src/components/layout/HostSlot.tsx`) where the content
  belongs, and the slot moves the host in. The owner also renders a `HostPark`,
  an invisible viewport-sized element that holds a host between the old
  layout's slot and the new one's within one commit.
  - `apps/web/src/lib/stable-host.ts` moves hosts with `moveBefore` where the
    engine has it (Chromium 133+, so every Electron build), which keeps scroll
    offsets and focus. It reads the document selection before every move and
    puts it back with `setBaseAndExtent`, because `moveBefore` still collapses
    the caret of a contenteditable composer. Other engines fall back to
    `appendChild` and get back the scroll offsets, focus, text-control
    selection and document selection read before the move.
- **App shell.** `AppShell` (`apps/web/src/components/layout/AppShell.tsx`)
  renders its content once into a stable host and shows it through `HostSlot`
  in whichever layout is current. `AppShell.test.tsx` covers it ("keeps its
  content mounted when the layout crosses the mobile breakpoint", which now also
  checks focus). The query is `MOBILE_SHELL_MEDIA_QUERY`, `(max-width: 767px)`,
  in `MobileAppShellLayout.tsx`.
- **Split panes.** `PaneTree` (`apps/web/src/components/pane-layout/PaneTree.tsx`)
  renders every leaf once into a host keyed by pane ID (`useStablePaneHosts`).
  The desktop split (`PaneSplitContainer`, nested `ResizablePanelGroup`s) and the
  `MobilePaneSwitcher` only position those hosts. Crossing the breakpoint in
  either direction, splitting a pane and closing the other half of a split all
  move panes instead of remounting them, so open dialogs, drafts, carets,
  scroll offsets and terminal attachments survive. `CoordinatorPaneTree`
  (`apps/web/src/components/projects/CoordinatorPaneTree.tsx`) uses the same
  hosts. Both use `MOBILE_SHELL_MEDIA_QUERY`.
  - Covered by `PaneTree.test.tsx` (mount counters and an open dialog across
    both directions, splitting, host cleanup), `stable-host.test.ts`, and the
    browser specs `e2e/PaneBreakpoint.spec.ts` (a real terminal pane and a
    native Codex pane crossing both ways, with `moveBefore` and with the
    fallback) and `e2e/CoordinatorPaneTree.spec.ts` (composer drafts and focus).
- **Panes the switcher hides.** `MobilePaneSwitcher` keeps every pane mounted
  and hides all but one with `display: none`.
  - `PersistentTerminal` no longer fits a terminal that has no layout box
    (`fitToLaidOutPane`). The fit addon used to read the hidden container's
    computed `100%` width as 100px and shrink the terminal and its PTY to about
    ten columns whenever its pane went hidden.
  - Switching panes in the switcher still resets a native transcript's scroll:
    one scrolled to message 28 showed message 53 after switching to the other
    pane and back, with no breakpoint crossing. Virtuoso re-measures a scroller
    that had no size. See the follow-up below.
- **Environment settings from the projects drawer.**
  - `MobileAppShellLayout` renders the sidebar inside a modal Radix `Dialog`
    (`mobile-projects-drawer`) without `forceMount`.
  - Each `EnvironmentItem` row (`apps/web/src/components/environments/EnvironmentItem.tsx`)
    owns `showSettingsDialog` and renders `LazyEnvironmentSettingsDialog`
    itself.
  - Choosing Settings from a row's "Environment actions" menu opens the dialog
    while the modal drawer stays open underneath, and the drawer blocks
    interaction with it. Closing the drawer first would not help on its own:
    the drawer's content unmounts when it closes, taking the row and its
    dialog state with it.
  - The ActionBar "Environment settings" button works
    (`ActionBar.view.tsx`, whose `envSettingsEnvironmentId` state lives outside
    the drawer). #988 changed shell mounting but not this path.

## Outstanding work

### Code

1. **Move the environment settings dialog out of the sidebar row.** Hold the
   target environment in a store or in a host outside the drawer, following
   the ActionBar's `envSettingsEnvironmentId` pattern. The row only requests
   it, and the drawer closes when the dialog opens. Done when Settings opened
   from a row is interactive in a narrow viewport.
2. **Keep the panes the switcher hides laid out.** Hide inactive panes with
   `visibility: hidden` layers (`invisible absolute inset-0`, plus `inert`)
   instead of `display: none`, so a hidden pane keeps its size. That keeps a
   native transcript's scroll offset across a pane switch, and also covers the
   fit paths `fitToLaidOutPane` skips today, including the environment
   visibility redraw in `persistent-terminal-redraw.ts`, which still fits a
   terminal whose pane is hidden. Update the `hidden` assertions in
   `MobilePaneSwitcher.test.tsx` and `PaneTree.test.tsx`. Done when switching
   panes keeps the transcript's first visible message, in a browser spec.

### Qualification

- `e2e/PaneBreakpoint.spec.ts` crosses the breakpoint mid-test in the
  `mobile-chromium` and `desktop-chromium` projects for split panes. Settings
  from the drawer still needs a narrow-browser check.
- Rotate a real phone, or an iOS simulator, with a split open and with a
  terminal pane visible. Safari has no `moveBefore`, so this exercises the
  `appendChild` fallback, which the browser spec only emulates in Chromium.

## Constraints and rationale

- The narrow layout changes presentation only. Mounting, subscriptions and
  pane-local state must not depend on which layout is showing.
- Every pane inside the mobile switcher stays mounted, so terminal and agent
  views keep receiving backend updates while another pane is visible.
- A modal opened from inside the drawer must not stay trapped behind it. Dialog
  state that has to outlive the drawer must not live in a drawer row.
- **Hosts are moved, not overlaid.** The alternative was to leave every pane in
  one fixed container and position it over its layout slot from measured
  rectangles. That never moves DOM nodes, but it needs a resize observer per
  slot and a frame of lag while a divider is dragged. Moving hosts matches what
  `AppShell` already did, and `moveBefore` removes the state loss that made
  moving costly.
- **A park keeps `moveBefore` usable.** React unmounts the old layout before
  the new one mounts, and `moveBefore` only works between two connected
  parents. The old slot's layout cleanup still runs while the old layout is
  connected, so it moves the host into the park, and the new slot moves it on.
  The park is invisible but laid out at viewport size: a `display: none` park
  would destroy scroll offsets, and a zero-size one would let them clamp.
- **Lay out once while parked.** A media query reports its change before the
  frame lays out, so the hosts leave a layout Chromium has not laid out since
  the resize. Moving such a host on before any layout drops its scroll offsets
  despite `moveBefore`. `placeHost` reads `offsetHeight` once for a host coming
  out of the park, which costs one synchronous layout per pane at a breakpoint
  crossing.
- **Selections go back with `setBaseAndExtent`.** `addRange` on a node Chromium
  has not laid out since the move canonicalizes the caret to the node's start.
- **xterm re-anchors on every resize.** A terminal's first visible line moves
  by a few lines on any resize, crossing or not (50 to 52 for 1024 px to
  800 px wide). The browser spec therefore checks that the terminal is still
  scrolled back into its history, not that it shows one exact line.

## Related

- [test-suite-and-ci-health.md](test-suite-and-ci-health.md): browser suite
  ownership.
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md):
  iOS and Safari runs.

## Replaces

- `docs/2026-10-14/05-real-stack-suite-host-dependencies.md` ("Remaining
  limit": mobile split panes remount)
- `docs/improvements/containers/qualification.md` (the mobile settings item
  under "Known limitations and follow-ups")
