# 10 — Canvas navigation and accessibility

Status: Implemented (2026-09-24) — see the [implementation record](00-index.md#implementation-record).  
Dependencies: [03](03-client-controller-and-reconciliation.md),
[08](08-entry-readiness-and-library.md),
[09](09-selection-and-inspector.md).  
Findings: U3.

## Outcome

Users can find all their frames, manipulate them without a mouse, resize with
stable feedback, and inspect designs in a narrow pane. Preview mode permits
safe scrolling/hover while retaining the exact script/network restrictions.

## Owners

`DesignCanvasTab.tsx`, `DesignFrameView.tsx`, `design.css`, the controller, and
proposed small viewport/gesture helpers. Keep transform math independently
testable without building a second canvas rendering engine.

## Viewport behavior

- [ ] Define frame-space ↔ viewport-space conversions in one helper, accounting
  for pan, zoom, viewport origin, device scale assumptions, and sidebar bounds.
- [ ] Add Fit all, Fit selected frame/element, 100%, and reset-to-fit controls.
  Fit includes negative frame coordinates and label/handle padding and clamps
  to supported zoom. Empty canvas has a sensible default.
- [ ] Anchor wheel/pinch zoom to the pointer or viewport center: determine the
  frame-space point before changing scale, then adjust pan so it stays fixed.
- [ ] Handle platform wheel modifiers consistently and use non-passive listeners
  only on the active canvas. Prevent page zoom only when canvas zoom consumes
  the event; respect scrolling inside inspector/library controls.
- [ ] Persist small per-client view preferences by backend/environment/canvas:
  pan, zoom, selected frame, panel state. Throttle persistence and exclude HTML,
  element drafts, and backend execution state from pane layout.
- [ ] Revalidate restored values and frame existence. “Reset view” remains
  available if content is far away or saved dimensions no longer fit.

## Gestures and pending previews

- [ ] Keep current drag math in refs/gesture state so pointerup uses the latest
  coordinates even if a render has not flushed its last pointermove.
- [ ] Schedule visual movement once per animation frame. Accumulate keyboard
  deltas explicitly instead of repeatedly reading stale committed geometry.
- [ ] Preserve a marked optimistic preview from release until its operation
  settles and the corresponding snapshot is installed. On conflict, remove or
  reconcile it visibly; never silently snap to an unexplained old position.
- [ ] Provide numeric x/y/width/height fields and device presets for frames.
  Validate 32–4096 dimensions and existing coordinate bounds consistently.
- [ ] Support modifier-based proportional resizing only with a clear documented
  rule; do not introduce hidden geometry constraints.
- [ ] Selected-element preview may update local runtime styles temporarily, but
  must restore from authoritative HTML on cancel/reject. Serialize/commit only
  through the backend operation path, never from the preview DOM.
- [ ] On blur, lost pointer capture, pointercancel, unmount, and Escape, settle
  gesture state correctly. A submitted operation continues in the backend.

## Keyboard and assistive technology

- [ ] Expose a navigable frame list and a semantic expandable layer tree/list.
  Selected, expanded, and pending states must be programmatically available.
- [ ] Provide keyboard move and resize for frames, with a small step and Shift
  larger step. Arrow keys inside editable text/number controls retain their
  native meaning. Offer numeric alternatives to every drag action.
- [ ] Escape cancels an unsent gesture, exits preview/selection as appropriate,
  and closes drawers in a consistent priority order without discarding submitted
  work. Publish shortcuts in an accessible help popover.
- [ ] Ctrl/Cmd+Z routes to design undo only when focus/context belongs to the
  canvas; a text field uses native text undo. Handle redo similarly.
- [ ] Announce completed/conflicting edits concisely in a live region; avoid
  announcing every drag sample or poll.
- [ ] Ensure focus-visible styling, meaningful icon labels, adequate target size,
  contrast, reduced-motion behavior, and focus restoration from menus/dialogs.
- [ ] Resize handles and overlays must not obscure the only focus target for a
  tiny element. Inspector/numeric controls provide an alternate route.

## Narrow-pane layout and preview

- [ ] Replace implicit overlapping panels with explicit Layers and Inspector
  drawers at narrow widths. Preserve state when switching between them.
- [ ] Opening a drawer moves focus appropriately and closing returns it to the
  trigger/selected element control. Test actual pane width, not only window width.
- [ ] Add Inspect/Preview mode with a visible exit control outside the iframe.
  Preview can route scroll/hover into the frame while blocking navigation,
  form submission, authored scripts, and external resources as before.
- [ ] Provide keyboard exit from preview and prevent focus being trapped inside
  authored markup. Treat links/buttons as mockup elements, not permission to
  navigate the application or open external pages.
- [ ] Re-entering Inspect refreshes element bounds/scroll offsets and selection
  references. Hit testing and overlays must agree after preview scrolling.

## Verification and acceptance

- [ ] Unit-test transform round trips, pointer-anchored zoom, fit calculations,
  negative coordinates, min/max bounds, and final-sample gesture commits.
- [ ] Browser-test keyboard-only creation/opening, frame movement/resize,
  selection, style editing, undo, export, and focus return.
- [ ] Test mouse, trackpad-style wheel, middle-button pan, touch/pointer cancel,
  high-DPI display, and narrow split panes where supported.
- [ ] Under delayed backend responses, previews remain stable and pending;
  rejection clearly restores/reconciles the authoritative geometry.
- [ ] While previewing/scrolled, return to inspection and hit the expected element.
- [ ] Unmount during gesture before submission versus after submission: no
  accidental commit in the first case; normal background completion in the second.
- [ ] Confirm no sandbox permissions or resource policies changed with Preview.

Review slices: math/view commands; pending gestures/numeric controls; keyboard
and undo routing; responsive panels; preview input routing and isolation tests.

## Implementation notes (2026-09-24)

- `design-viewport.ts`: conversions, pointer-anchored zoom, fit all/selection, 100%, restore validation, wheel modifier handling, presets and clamps; view preferences per backend/environment/canvas (`design-view-prefs.ts`).
- Gestures keep samples in refs and render once per animation frame; optimistic previews persist until the committed revision is installed; pointercancel/Escape before submission discard; keyboard move/resize (collapsed per burst); numeric frame fields.
- Shortcuts with ownership rules and an accessible help dialog; live-region announcements; Inspector drawer in narrow panes; Preview mode (scroll/hover in the frame, navigation/scripts/network still blocked, Escape returns).
- Not performed: manual screen-reader pass and Electron window QA.
