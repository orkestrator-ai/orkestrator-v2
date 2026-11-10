# Narrow layout

Below 768 px the renderer switches to a phone layout: a projects drawer instead
of the sidebar, and a pane switcher instead of resize handles. The query is
`MOBILE_SHELL_MEDIA_QUERY`, `(max-width: 767px)`, in
`apps/web/src/lib/mobile-shell.ts`. A window can cross
that breakpoint at any time: when it is narrowed, when a phone rotates (only
the largest iPhones are wider than 768 CSS px in landscape) or when iPad split
view starts. Crossing it must not throw away UI state, and every action has to
stay reachable in the narrow layout.

This document describes how that is built. It replaces to-dos 0035 (mobile
layout gaps) and 0202 (WebKit title tooltip), both retired on 2026-11-10; read
them with
`git show 53340356c:docs/todo/cross-cutting/0035-mobile-layout-gaps.md` and
`git show 53340356c:docs/todo/cross-cutting/0202-webkit-title-tooltip-outside-tap.md`.
The real iOS run of both is an item in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md#cross-cutting).

## Rules

- The narrow layout changes presentation only. Mounting, subscriptions and
  pane-local state must not depend on which layout is showing.
- Every pane inside the mobile switcher stays mounted, so terminal and agent
  views keep receiving backend updates while another pane is visible.
- A modal opened from inside the drawer must not stay trapped behind it.
  Dialog state that has to outlive the drawer must not live in a drawer row.
- The title tooltip is the only way to read a truncated title by touch, so it
  opens and closes on touch alone, and dismissing it must not activate what is
  under it.

## Stable hosts

Content that must survive a layout switch renders once, through a portal, into
a host element its owner keeps. Each layout renders a `HostSlot`
(`apps/web/src/components/layout/HostSlot.tsx`) where the content belongs, and
the slot moves the host in. The owner also renders a `HostPark`, an invisible
viewport-sized element that holds a host between the old layout's slot and the
new one's within one commit.

`apps/web/src/lib/stable-host.ts` moves hosts with `moveBefore` where the
engine has it (Chromium 133+, so every Electron build), which keeps scroll
offsets and focus. It reads the document selection before every move and puts
it back with `setBaseAndExtent`, because `moveBefore` still collapses the caret
of a contenteditable composer. Other engines (Playwright's WebKit 27.2, and iOS
when its WebKit lacks `moveBefore`) fall back to `appendChild` and get back the
scroll offsets, focus, text-control selection and document selection read
before the move.

- **App shell.** `AppShell` (`apps/web/src/components/layout/AppShell.tsx`)
  renders its content once into a stable host and shows it through `HostSlot`
  in whichever layout is current.
- **Split panes.** `PaneTree` (`apps/web/src/components/pane-layout/PaneTree.tsx`)
  renders every leaf once into a host keyed by pane ID (`useStablePaneHosts`).
  The desktop split (`PaneSplitContainer`, nested `ResizablePanelGroup`s) and
  the `MobilePaneSwitcher` only position those hosts. Crossing the breakpoint
  in either direction, splitting a pane and closing the other half of a split
  all move panes instead of remounting them, so open dialogs, drafts, carets,
  scroll offsets and terminal attachments survive. `CoordinatorPaneTree`
  (`apps/web/src/components/projects/CoordinatorPaneTree.tsx`) uses the same
  hosts.

## Panes the switcher hides

`MobilePaneSwitcher` keeps every pane mounted and stacks them at full size
(`absolute inset-0`). A hidden pane has inline `visibility: hidden`,
`opacity: 0` and `pointer-events: none`, plus `inert`, so it keeps its layout
box while staying out of the tab order and the accessibility tree. It never
gets `display: none` or the `hidden` attribute.

- `PaneTree` passes `hiddenByLayout` to the panes the switcher hides.
  `PaneLeafContainer` then keeps the pane's active tab laid out while
  `isActive` stays false (no shortcuts, not counted as on screen).
- `AgentNativeTab` re-locks its transcript to the end on every activation
  (`stickToBottomOnActivation`). It passes `isActive || hiddenByLayout` to
  `useVirtuosoScrollState`, so coming back from a pane switch keeps the
  transcript where the user left it. Environment switches and tab switches
  within a pane still re-lock it.
- A hidden terminal keeps the size its pane has on screen. Every fit in
  `PersistentTerminal` goes through `fitToLaidOutPane`, and the environment
  visibility redraw in `persistent-terminal-redraw.ts` takes a `canFit` guard.
  Both use `hasLayoutBox`. A terminal with no layout box keeps its size instead
  of being shrunk, with its PTY, to about ten columns: the fit addon reads a
  `display: none` container's computed `100%` width as 100px.
- A hidden pane's tab strip, tabs and edge zones sit at the same coordinates
  as the visible pane's, and dnd-kit measures droppables regardless of
  visibility. The shared tab collision detection
  (`createTerminalCollisionDetection` in `TerminalContainer.helpers.ts`, also
  used by `CoordinatorPaneTree`) skips droppables inside an `inert` subtree,
  so a drop lands in the pane on screen.
- Browser tabs still hide when inactive, because their native preview view has
  to, and the design canvas still unmounts its content when inactive.

## Settings from the projects drawer

- `MobileAppShellLayout` renders the sidebar inside a modal Radix `Dialog`
  (`mobile-projects-drawer`) without `forceMount`, so the drawer's rows unmount
  when it closes.
- No sidebar row renders the environment settings dialog. A request
  `{ kind: "environment-settings", environmentId }` goes into
  `useAppDialogStore` (`apps/web/src/stores/appDialogStore.ts`), and
  `AppDialogHost` (`apps/web/src/components/layout/AppDialogHost.tsx`),
  mounted once in `AppShell` outside both layouts and inside
  `DockerAvailabilityProvider`, renders the lazy `EnvironmentSettingsDialog`.
  The host writes the dialog's changes to the environment store and drops a
  request whose environment disappears.
- `SidebarBottomBar` records the same request for local repository and
  environment settings. A remote selection opens the owning node's workspace
  in the window's own tree (a request in `remoteWorkspaceStore`), preserving its
  environment selection. `ServiceBrowserTab` still renders its own copy of the
  dialog for a preview tab's "configure mapping" recovery action; it is not in
  the drawer.
- The drawer subscribes to the store and closes when a request arrives. It
  leaves focus to the dialog, and gives it to the drawer trigger, standing in
  for the unmounted row, once the dialog closes. It focuses the trigger in an
  effect after the commit that unmounts the dialog (a counter bumped from the
  store callback), not from the callback itself: the settings layer's focus
  trap would otherwise pull focus straight back.
- `FullscreenSettingsLayout` wraps its dialog in a Radix `FocusScope`
  (`trapped`, `loop`). It focuses the first tabbable control on open, returns
  focus to its opener on close unless something else has placed focus by then,
  and keeps Tab and Shift+Tab inside the layer. Radix layers opened from inside
  it (selects, menus, alert dialogs) share Radix's focus-scope stack, so they
  pause the trap while they are open.
- The drawer backdrop has no click handler of its own. Radix closes the drawer
  on a press outside it, and only while the drawer is the top layer, so a
  press outside a row's open menu closes only the menu.

## Title tooltip on touch

On a phone the shell's title truncates. Tapping it opens a controlled Radix
`Tooltip` (`titleTooltipOpen` in `MobileAppShellLayout`) with the whole title.
A tap that is really outside the bubble closes it through Radix's
`DismissableLayer` on `pointerdown`, in every engine. A tap on the bubble
itself is inside the layer, so Radix does nothing; Chromium used to close it
only because the tap blurred the focused title, and WebKit never focuses a
tapped button. The bubble therefore closes itself: `TooltipContent` closes on
`touchend` and cancels that `touchend`, which also cancels the tap's
compatibility mouse events and click, so the tap does not reach the workspace
control under the bubble. A pen tap, which has no touch events, closes it from
the bubble's click (`pointerType === "pen"`). The handler is local to the
title, not in the shared `tooltip.tsx`, because this is the only tooltip that
opens on touch.

## Design choices

- **Hosts are moved, not overlaid.** Leaving every pane in one fixed container
  positioned over its slot from measured rectangles never moves DOM nodes, but
  needs a resize observer per slot and a frame of lag while a divider is
  dragged. Moving hosts matches what `AppShell` already did, and `moveBefore`
  removes the state loss that made moving costly.
- **A park keeps `moveBefore` usable.** React unmounts the old layout before
  the new one mounts, and `moveBefore` only works between two connected
  parents. The old slot's layout cleanup runs while the old layout is still
  connected, so it moves the host into the park, and the new slot moves it on.
  A `display: none` park would destroy scroll offsets, and a zero-size one
  would let them clamp.
- **Lay out once while parked.** A media query reports its change before the
  frame lays out, so hosts leave a layout Chromium has not laid out since the
  resize, and moving one on before any layout drops its scroll offsets despite
  `moveBefore`. `placeHost` (`HostSlot.tsx`) reads `offsetHeight` once for a host coming out of
  the park: one synchronous layout per pane at a breakpoint crossing.
- **Selections go back with `setBaseAndExtent`.** `addRange` on a node
  Chromium has not laid out since the move canonicalizes the caret to the
  node's start.
- **Dialogs requested from the drawer live in one app-level host.** Closing
  the drawer from a row that still owned the dialog unmounts the dialog with
  the row; keeping the drawer mounted with `forceMount` keeps every row and its
  subscriptions alive while hidden. A store request plus `AppDialogHost`
  follows the existing `errorDialogStore` pattern.
- **Hidden panes are invisible layers, not removed boxes.** `display: none`
  loses scroll offsets and gives a terminal nothing to fit to. Moving hidden
  panes offscreen keeps them laid out but leaves them focusable unless made
  `inert` anyway. Inline styles keep the hidden state checkable in happy-dom,
  and `opacity: 0` hides descendants that set `visibility: visible`. There is
  no `aria-hidden`: `inert` and `visibility: hidden` already remove the pane
  from the accessibility tree, and Chrome warns when `aria-hidden` lands on a
  pane that still holds focus. Hidden panes keep laying out (painting is
  skipped), as every pane does on desktop.
- **A click straight after a drop is swallowed, by design.** Once a pointer
  drag activates, dnd-kit's `PointerSensor` swallows document clicks for 50 ms
  after the drop (`detach()` in `@dnd-kit/core` 6.3.1), so the click after the
  drag's own `pointerup` does not select the dragged tab. The narrow-window
  drag case in `e2e/CoordinatorPaneTree.spec.ts` installs Playwright's clock
  and runs it 50 ms after each drop; the product keeps dnd-kit's stock sensor.
- **xterm re-anchors on every resize.** A terminal's first visible line moves
  by a few lines on any resize, crossing or not, so browser specs check that
  the terminal is still scrolled back into its history, not one exact line.

## Tests

- Unit: `AppShell.test.tsx`, `PaneTree.test.tsx`, `stable-host.test.ts`,
  `MobilePaneSwitcher.test.tsx`, `PaneLeafContainer.test.tsx`,
  `persistent-terminal-redraw.test.ts`, `TerminalContainer.helpers.test.tsx`,
  `AppDialogHost.test.tsx`, `SidebarBottomBar.test.tsx`,
  `MobileAppShellLayout.test.tsx` (including touch and pen taps on the title
  bubble), `FullscreenSettingsLayout.test.tsx`,
  `tests/unit/components/EnvironmentItem.test.tsx` and
  `HierarchicalSidebar.test.tsx`.
- Component browser specs: `e2e/PaneBreakpoint.spec.ts`,
  `e2e/CoordinatorPaneTree.spec.ts`, `e2e/EnvironmentSettingsDrawer.spec.ts`,
  `e2e/FullscreenSettingsLayout.spec.ts` and `e2e/MobileAppShellLayout.spec.ts`.
  CI runs `MobileAppShellLayout.spec.ts` in Chromium and WebKit; the others run
  under WebKit on demand with `ORKESTRATOR_E2E_BROWSER=webkit`
  ([testing guide](../development/testing-guide.md)), which exercises the
  `appendChild` fallback natively.
- Real stack: `e2e/agent-testing/terminal-mobile-panes.spec.ts` hides a split
  terminal's pane on a phone, switches environments until a shell loop ends,
  and checks that no resize reached the PTY while it was away and that the PTY
  matches the rendered terminal on return and after a reload.

Playwright's WebKit runs on a desktop host with emulated touch: it does not
rotate, and has no iOS visual viewport, on-screen keyboard or `WKWebView`. A
2026-10-27 iOS 26.5 Simulator run in Safari matched Playwright's WebKit for the
title tooltip before and after the fix; the rotation and drawer checks have not
been run on iOS.
