# Mobile layout gaps

Checked against `main` at `9906db30` (2026-10-16).

Below 768 px the renderer switches to a phone layout: a projects drawer instead
of the sidebar, and a pane switcher instead of resize handles. A window can
cross that breakpoint at any time, for example when it is narrowed, when a phone
rotates or when split-screen starts. Crossing it must not throw away UI state,
and every action has to stay reachable in the narrow layout. #988 fixed this for
the app shell, stable per-pane hosts fixed it for split panes, and an app-level
dialog host fixed environment settings opened from the projects drawer, and
panes the mobile switcher hides now stay laid out. What remains is two small
settings follow-ups and real-device qualification.

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
    fallback, alone and inside the real `AppShell`, which moves its own content
    host at the same breakpoint) and `e2e/CoordinatorPaneTree.spec.ts`
    (composer drafts and focus).
- **Panes the switcher hides.** `MobilePaneSwitcher` keeps every pane mounted
  and stacks them at full size (`absolute inset-0`). A hidden pane has inline
  `visibility: hidden`, `opacity: 0` and `pointer-events: none`, plus `inert`,
  so it keeps its layout box while staying out of the tab order and the
  accessibility tree. It never gets `display: none` or the `hidden` attribute.
  - `PaneTree` passes `hiddenByLayout` to the panes the switcher hides.
    `PaneLeafContainer` then keeps the pane's active tab laid out, where it
    used to hide an inactive pane's tab with `display: none`, while `isActive`
    stays false (no shortcuts, not counted as on screen).
  - `AgentNativeTab` re-locks its transcript to the end on every activation
    (`stickToBottomOnActivation`). It passes `isActive || hiddenByLayout` to
    `useVirtuosoScrollState`, so coming back from a pane switch keeps the
    transcript where the user left it. Environment switches and tab switches
    within a pane still re-lock it.
  - A hidden terminal keeps the size its pane has on screen. Every fit in
    `PersistentTerminal` goes through `fitToLaidOutPane`, and the environment
    visibility redraw in `persistent-terminal-redraw.ts` takes a `canFit`
    guard. Both use `hasLayoutBox`. A terminal with no layout box at all keeps
    its size instead of being shrunk, with its PTY, to about ten columns: the
    fit addon reads a `display: none` container's computed `100%` width as
    100px.
  - A hidden pane's tab strip, tabs and edge zones sit at the same coordinates
    as the visible pane's, and dnd-kit measures droppables regardless of
    visibility. The shared tab collision detection
    (`createTerminalCollisionDetection` in `TerminalContainer.helpers.ts`, also
    used by `CoordinatorPaneTree`) skips droppables inside an `inert` subtree,
    so a drop lands in the pane on screen.
  - Before this, switching panes on a phone, with no breakpoint crossing,
    jumped a native transcript from message 28 to 53, and a terminal hidden at
    load stayed at xterm's default 80 columns until it was shown.
  - Browser tabs still hide when inactive, because their native preview view
    has to, and the design canvas still unmounts its content when inactive.
  - Covered by `MobilePaneSwitcher.test.tsx` (laid out, `inert`, out of the
    accessibility tree), `PaneLeafContainer.test.tsx` (the hidden pane's active
    tab stays laid out but inactive), `PaneTree.test.tsx`,
    `persistent-terminal-redraw.test.ts`, and the `mobile-chromium` case in
    `e2e/PaneBreakpoint.spec.ts` that switches panes back and forth and checks
    the transcript's first visible message, the terminal's columns, rows and
    scroll line. `TerminalContainer.helpers.test.tsx` and the narrow-window drag
    case in `e2e/CoordinatorPaneTree.spec.ts` cover drops. Against the real
    backend, `e2e/agent-testing/terminal-mobile-panes.spec.ts` runs a shell
    loop in a split on a phone, hides its pane, switches environments until the
    loop ends, and checks that no resize reached the PTY while it was away,
    that the output and status come back, and that the PTY matches the
    rendered terminal on return and after a reload.
- **Environment settings from the projects drawer.**
  - `MobileAppShellLayout` renders the sidebar inside a modal Radix `Dialog`
    (`mobile-projects-drawer`) without `forceMount`, so the drawer's rows
    unmount when it closes.
  - An `EnvironmentItem` row (`apps/web/src/components/environments/EnvironmentItem.tsx`)
    no longer renders the settings dialog. Settings records
    `{ kind: "environment-settings", environmentId }` in `useAppDialogStore`
    (`apps/web/src/stores/appDialogStore.ts`), and `AppDialogHost`
    (`apps/web/src/components/layout/AppDialogHost.tsx`), mounted once in
    `AppShell` outside both layouts, renders the lazy
    `EnvironmentSettingsDialog`. The host writes the dialog's changes to the
    environment store and drops a request whose environment disappears.
  - `MobileAppShellLayout` subscribes to the store and closes the drawer when a
    request arrives. It leaves focus to the dialog, and gives it to the drawer
    trigger, standing in for the unmounted row, once the dialog closes.
  - `FullscreenSettingsLayout` takes focus when it opens and returns it to its
    opener when it closes, unless something else has placed focus by then.
  - The drawer backdrop no longer has its own click handler. Radix closes the
    drawer on a press outside it, and only while the drawer is the top layer.
  - The ActionBar "Environment settings" button still keeps its own
    `envSettingsEnvironmentId` state and dialog (`ActionBar.view.tsx`). It
    lives outside the drawer and works; see the follow-ups.
  - Covered by `AppDialogHost.test.tsx`, `MobileAppShellLayout.test.tsx` (the
    drawer gives way to a requested dialog; a click on the backdrop that a
    press inside the drawer began does not close it),
    `tests/unit/components/EnvironmentItem.test.tsx` and
    `HierarchicalSidebar.test.tsx`, and the browser specs
    `e2e/EnvironmentSettingsDrawer.spec.ts` (touch taps and the keyboard
    through the drawer into an interactive settings dialog, focus on the
    drawer trigger after it closes, then reopen the drawer),
    `FullscreenSettingsLayout.test.tsx` (focus in and back out) and
    `e2e/MobileAppShellLayout.spec.ts` (tapping the backdrop closes the drawer
    and returns focus).
  - **Before the fix, in `mobile-chromium` (390 × 844):** a touch tap on a
    row's "Environment actions" button closed the whole drawer, so Settings
    was unreachable by touch. The tap opens the menu on `pointerdown`; the
    drawer then stops taking pointer events under the menu's modal layer, and
    the tap's `click` lands on the backdrop, whose `onClick` closed the drawer.
    With that handler removed, Settings opened the dialog while the drawer
    stayed open: `body` and the settings dialog both computed
    `pointer-events: none`, and tapping the "Settings section" picker did
    nothing.

## Outstanding work

### Code

1. **Open the ActionBar's environment settings through `AppDialogHost`.** The
   ActionBar still holds `envSettingsEnvironmentId` and renders its own copy
   of the dialog (`useActionBarController.ts`, `ActionBar.view.tsx`). Moving
   it onto `useAppDialogStore` leaves one host for the dialog. Its tests in
   `ActionBar.test.tsx` mock the dialog and would follow it to the host.
2. **Trap focus in fullscreen settings.** `FullscreenSettingsLayout` now
   takes focus and gives it back, but Tab can still leave it for the page
   underneath once it reaches its last control.

### Qualification

- In Chromium both fixes are checked in a narrow browser:
  `e2e/PaneBreakpoint.spec.ts` crosses the breakpoint mid-test in the
  `mobile-chromium` and `desktop-chromium` projects, and
  `e2e/EnvironmentSettingsDrawer.spec.ts` opens Settings from the drawer by
  touch in `mobile-chromium`.
- Rotate a real phone, or an iOS simulator, with a split open and with a
  terminal pane visible, and open Settings from the drawer there. Safari has
  no `moveBefore`, so this exercises the `appendChild` fallback, which the
  browser spec only emulates in Chromium.

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
- **Dialogs requested from the drawer live in one app-level host.** The
  alternatives were to close the drawer from the row before opening a dialog
  the row still owned (the row unmounts with the drawer and takes the dialog
  with it), or to keep the drawer mounted when closed with `forceMount` (a
  hidden drawer keeps every row and its subscriptions alive). A store request
  plus `AppDialogHost` follows the ActionBar's state-outside-the-drawer
  pattern and the existing `errorDialogStore`. The host sits in `AppShell`,
  inside `DockerAvailabilityProvider`, which the settings dialog reads.
- **The drawer closes itself.** It subscribes to `useAppDialogStore` and gives
  way to any request, so a row only records what it wants and never reaches
  into the layout. The subscription sets state from a store callback rather
  than from an effect body.
- **The row's update plumbing is gone.** With the dialog in the host,
  `EnvironmentItem`'s `onUpdate` prop and its local transitioning flag had no
  caller. The host writes updates to the environment store, which is what
  the sidebar's handler did, and the row shows a transition from the status
  it then reads. `onUpdate`, `onUpdateEnvironment` and
  `createEnvironmentUpdateHandler` were removed from the sidebar components.
- **No click handler on the drawer backdrop.** Radix's own outside-press
  dismissal respects its layer stack: while a row's menu is open above the
  drawer, a press outside closes only the menu. The backdrop's `onClick`
  bypassed that and closed the drawer on the click that ends a tap.
- **Hidden panes are invisible layers, not removed boxes.** `display: none`
  destroys a pane's layout box, which loses its scroll offsets and gives a
  terminal nothing to fit to. Moving hidden panes offscreen would also keep
  them laid out, but leaves them focusable and in the accessibility tree
  unless they are made `inert` anyway. Inline styles rather than Tailwind
  classes keep the hidden state checkable in happy-dom; `opacity: 0` hides
  descendants that set `visibility: visible`. There is no `aria-hidden`:
  `inert` and `visibility: hidden` already remove the pane from the
  accessibility tree, and Chrome warns when `aria-hidden` lands on a pane that
  still holds focus. The cost is that hidden panes keep laying out (painting
  is skipped), as every pane does on desktop.
- **A click straight after a drop is swallowed, by design.** Once a pointer
  drag activates, dnd-kit's `PointerSensor` adds a capture-phase `click`
  listener on the document that calls `stopPropagation()`, and removes it 50 ms
  after the drop (`detach()` in `@dnd-kit/core` 6.3.1). That stops the click
  the browser fires after the drag's own `pointerup` from selecting the tab
  that was dragged. A click in that window never reaches React, so the
  narrow-window drag case in `e2e/CoordinatorPaneTree.spec.ts` used to fail
  whenever Playwright clicked the switcher tab within 50 ms of the first drop
  (every run alone on a quiet host, on `31d0fb06` and `9da80451`). The fault was
  in the test, not the switcher: no person clicks a second control within
  50 ms of releasing a drag. The spec now installs Playwright's clock (time
  still flows) and its `dragTo` helper runs the clock 50 ms after each drop,
  which fires dnd-kit's cleanup timer before the next step. The product keeps
  dnd-kit's stock sensor: a custom sensor that dropped only the drag's own
  trailing click would be ours to keep in step with dnd-kit for no
  user-visible gain.
- **xterm re-anchors on every resize.** A terminal's first visible line moves
  by a few lines on any resize, crossing or not (50 to 52 for 1024 px to
  800 px wide). The browser spec therefore checks that the terminal is still
  scrolled back into its history, not that it shows one exact line.

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): browser suite
  ownership.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  iOS and Safari runs.

## Replaces

- `docs/2026-10-14/05-real-stack-suite-host-dependencies.md` ("Remaining
  limit": mobile split panes remount)
- `docs/improvements/containers/qualification.md` (the mobile settings item
  under "Known limitations and follow-ups")
