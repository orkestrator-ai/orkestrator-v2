# Mobile layout gaps

Checked against `main` at `2459b05c` (2026-10-15).

Below 768 px the renderer switches to a phone layout: a projects drawer instead
of the sidebar, and a pane switcher instead of resize handles. A window can
cross that breakpoint at any time, for example when it is narrowed, when a phone
rotates or when split-screen starts. Crossing it must not throw away UI state,
and every action has to stay reachable in the narrow layout. #988 fixed this for
the app shell. Two gaps remain.

## Current state

- **App shell.** `AppShell` (`apps/web/src/components/layout/AppShell.tsx`)
  renders its content once into a stable host element and portals it into
  whichever layout is showing (`ContentSlot`). Content therefore does not
  remount at the breakpoint. `AppShell.test.tsx` covers this ("keeps its
  content mounted when the layout crosses the mobile breakpoint"). The query is
  `MOBILE_SHELL_MEDIA_QUERY`, `(max-width: 767px)`, in
  `MobileAppShellLayout.tsx`.
- **Split panes.** `PaneSplitContainer` (`apps/web/src/components/pane-layout/PaneTree.tsx`)
  runs its own `useMediaQuery("(max-width: 767px)")`.
  - On mobile it returns `MobilePaneSwitcher`, with every leaf of the split
    flattened by `collectPaneLeaves`. Otherwise it renders nested
    `ResizablePanelGroup`s.
  - The two branches are different element trees. Each time the window crosses
    the breakpoint, in either direction, React unmounts every
    `PaneLeafContainer` under the split and mounts new ones. Open dialogs and
    pane-local state are lost; backend state is unaffected.
  - Inside the switcher every pane stays mounted, with the hidden ones marked
    `hidden`. A layout with a single pane never branches and is not affected.
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

1. **Keep split panes mounted across the breakpoint.** Render each leaf once
   into a stable host keyed by pane ID, and let the desktop and mobile split
   layouts only position those hosts, as `AppShell` does for its content. Use
   `MOBILE_SHELL_MEDIA_QUERY` instead of a second literal query. Done when a
   component test shows no `PaneLeafContainer` remount after crossing in each
   direction, with an open dialog surviving. The mount counters in
   `PaneLeafContainer.test.tsx` are a model.
2. **Move the environment settings dialog out of the sidebar row.** Hold the
   target environment in a store or in a host outside the drawer, following
   the ActionBar's `envSettingsEnvironmentId` pattern. The row only requests
   it, and the drawer closes when the dialog opens. Done when Settings opened
   from a row is interactive in a narrow viewport.

### Qualification

- Check both fixes in a real narrow browser, before and after.
  `mise run test:browser` has `mobile-chromium` (390 × 844) and
  `desktop-chromium` (1024 × 900) projects, but no spec crosses the breakpoint
  mid-test. A breakpoint case needs `page.setViewportSize`, as
  `e2e/MobileAppShellLayout.spec.ts` does.
- Rotate a real phone, or an iOS simulator, with a split open and with a
  terminal pane visible.

## Constraints and rationale

- The narrow layout changes presentation only. Mounting, subscriptions and
  pane-local state must not depend on which layout is showing.
- Every pane inside the mobile switcher stays mounted, so terminal and agent
  views keep receiving backend updates while another pane is visible.
- A modal opened from inside the drawer must not stay trapped behind it. Dialog
  state that has to outlive the drawer must not live in a drawer row.

## Needs verification

- Whether the settings defect still reproduces in a real narrow browser. The
  code path is unchanged since it was found during container qualification.

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
