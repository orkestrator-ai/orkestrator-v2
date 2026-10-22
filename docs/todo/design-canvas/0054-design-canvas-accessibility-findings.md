# Design canvas accessibility findings

Checked against `main` at `b83ae534` (2026-10-22).

The automated accessibility pass of
[0036-design-canvas-qualification.md](0036-design-canvas-qualification.md#accessibility)
(`e2e/DesignCanvasAccessibility.spec.ts`) fixed seven focus and announcement
defects, then two more under load, and found the three below, which it does
not assert. The human screen-reader pass stays in 0036.

## Current state

- The spec runs the keyboard-only journey at desktop and phone widths, at
  640×450 @2x (about 200% zoom) and in a 320 px pane, and passes. Its header
  records the observations.
- At 320×225 @4x (about 400% zoom) only the select, edit and close journey
  runs; the clipped layout below is not asserted. Its screenshots are
  attached to the run.

## Outstanding work

### Code

1. **400% zoom layout.** At 320×225 CSS px the canvas toolbar
   (`DesignToolbar` in `apps/web/src/components/design/`) wraps to three rows
   and takes about half the height, so the Layers tree and the inspector
   fields shrink to a sliver. They stay focusable and operable, but a sighted
   keyboard user cannot see them (WCAG 1.4.10 reflow). Collapse the toolbar
   into an overflow menu, or let the panels take over the pane, below a
   height breakpoint. Then add a 400% case to the spec that asserts that the
   focused control is visible.
2. **Label in name.** Inspector fields are named by CSS property, not their
   visible label: visible "Fill" is announced "background-color", and "Align
   items" is "align-items" (WCAG 2.5.3, which matters for speech input). Tests
   and agent tooling address fields by these names (`getByLabel("color")`,
   `data-property`), so change the accessible name to the visible label and
   keep the property in `data-property` or the description, updating the
   tests in the same change.
3. **Enter on a row of a frame that has not rendered.** Enter only brings the
   frame into view; a second Enter selects, and nothing is announced. Select
   on the first Enter once the frame mounts, or announce why nothing was
   selected.

## Constraints and rationale

- Never weaken the focus watcher further: a stay on `<body>` shorter than two
  frames and 100 ms is tolerated only because Radix restores dialog focus
  from a zero-delay timer, which runs late on a loaded host.
- Layer-tree windowing must keep the focused and the selected rows mounted
  (the deliberate deviation from `react-virtuoso` recorded in
  [0036](0036-design-canvas-qualification.md#constraints-and-rationale)), and
  a culled frame keeps the chrome that holds focus.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md)
  holds the screen-reader pass and the evidence.
