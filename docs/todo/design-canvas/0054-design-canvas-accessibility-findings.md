# Design canvas accessibility findings

Checked against `main` at `b83ae534` (2026-10-22). All three items fixed on
branch `todo-0054-design-a11y-findings-ec88681caf58` (from `main` at
`ba7cc8d4`, 2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire the finished file**: all three findings (400% zoom layout, label in name, Enter on an unrendered frame's row) shipped in #1244 and are asserted; only the file itself is left. Status: done.

### 1. Retire the finished file

**Problem.** Every item is done and the folder index already says Finished: Yes, but the file is still in `todo/`. The README says a finished file is deleted once its durable behaviour lives in `architecture/` or `development/`.

**Context.** The findings came out of the automated accessibility pass in 0036. The human screen-reader pass is not part of this file and stays in 0036. The ID 0054 is also used by `todo/previews-and-annotations/0054-preview-cross-service-reads.md` and `todo/cross-cutting/0054-agent-test-pi-default-model.md`. All three were created on 2026-10-22 in parallel PRs (#1146, #1148, #1151), which breaks the README rule that numbers are unique across folders. No unit test checks for this.

**Investigation.** The fixes are all at HEAD, unchanged since #1244 (`5a8b11b9`):
- `SHORT_HEIGHT = 400` and `PENDING_ELEMENT_MS = 10_000` are at `apps/web/src/components/design/DesignCanvasTab.tsx:71` and `:73`, and the compact check at `:113`.
- `toolsOf` and the **More design tools** trigger are at `apps/web/src/components/design/DesignToolbar.tsx:146` and `:287`.
- `aria-labelledby` and `data-property` are at `apps/web/src/components/design/DesignStyleField.tsx:224` and `:139`.

The durable behaviour is already in `docs/architecture/design-canvas.md:297-312` (short-pane toolbar, label-in-name, deferred Enter) and `:460` (what the spec covers). The focus-watcher tolerance is recorded in the header of `e2e/DesignCanvasAccessibility.spec.ts:36-37`, and the spec defines the `arrowTo` helper at `:823`. The layer-tree windowing deviation is recorded in 0036's "Constraints and rationale", not in `architecture/`. Three things link to this file and would need updating on deletion: 0036 (Related, the Manual accessibility item, and the Accessibility evidence), `design-canvas.md` (indirectly, through 0036), and the folder index row.

**Decisions.**

- **What to do with the finished file?**
  - **Delete it now and update the links (recommended).** Remove the file and its index row. Point 0036's three links at `design-canvas.md#client`. Move the windowing deviation and the "Radix menus need `arrowTo` and stable item keys" note into `design-canvas.md` ("Client" or "Tests").
    - Pros: follows the README; removes one of the three files using ID 0054; nothing durable is lost, because the behaviour is already in `architecture/`.
    - Cons: the WCAG reasoning (options a/b/c for the toolbar, the 400 px breakpoint choice) survives only in git history and PR #1244 unless it is copied over.
  - **Keep it until 0036's screen-reader pass is done.** That pass may revisit the label-only names and the announcement wording.
    - Pros: the human tester has the design rationale next to the checklist.
    - Cons: breaks the README's delete-when-finished rule; the ID collision stays; 0036 can link to `design-canvas.md` for the same purpose.
- **Fix the 0054 ID collision?**
  - **Let deleting this file remove it from this folder and raise the collision with the owners of the other two (recommended).** Their numbers are permanent IDs, and renumbering would break inbound links.
    - Pros: no link churn in other folders; the design folder no longer contributes to the clash.
    - Cons: two 0054 files still exist elsewhere until someone decides.
  - **Also add a unit test that fails on duplicate todo IDs, allowlisting the two that remain.**
    - Pros: stops parallel PRs from repeating the clash, which this case shows is easy to do.
    - Cons: cross-cutting work that belongs in a new cross-cutting todo, not here; the allowlist has to be maintained.

The automated accessibility pass of
[0036-design-canvas-qualification.md](0036-design-canvas-qualification.md#accessibility)
(`e2e/DesignCanvasAccessibility.spec.ts`) fixed seven focus and announcement
defects, then two more under load, and found the three below, which it did
not assert. They are now fixed and asserted. The human screen-reader pass
stays in 0036.

## Current state

- The spec runs the keyboard-only journey at desktop and phone widths, at
  640×450 @2x (about 200% zoom), at 320×225 @4x (about 400% zoom) and in a
  320 px pane, and passes. Its header records the observations.
- At 400% zoom every focused control outside the pannable canvas is
  unclipped and uncovered (the same check as at 200%; the 400% exemption is
  gone), the toolbar is one row, a focused inspector field's label is on
  screen with it, and the overflow menu's zoom steps, an action and a dialog
  it opens all keep focus. Screenshots are attached to each run.

## Outstanding work

None. Every item below is done.

### Code

1. ~~**400% zoom layout.**~~ **Done 2026-10-25.** At 320×225 CSS px the
   toolbar wrapped to three rows and took about half the height, so the
   Layers tree and the inspector fields shrank to a sliver (WCAG 1.4.10).
   - Below 400 px of workspace height (`SHORT_HEIGHT` in
     `apps/web/src/components/design/DesignCanvasTab.tsx`) the workspace gets
     `data-short` and `DesignToolbar` is compact: the Layers toggle, the
     design name, the narrow inspector toggle and a **More design tools**
     menu holding every other tool, in one row. The tools are one list
     (`toolsOf`) rendered as inline buttons or menu items, so the two cannot
     drift. Zoom steps keep the menu open; other items run from
     `onCloseAutoFocus`, after focus is back on the trigger, so a dialog they
     open returns focus there.
   - In a short pane the inspector scrolls as one column instead of a fixed
     header and Apply bar around a scrolling middle, and the Layers heading
     and filter note are visually hidden but stay available to assistive
     technology (`design.css`). Before this the fields area was about 25 CSS
     px: one clipped field.
   - Evidence: the 400% case in `e2e/DesignCanvasAccessibility.spec.ts` now
     asserts no clipped or covered control in the idle and inspector Tab
     sweeps, a one-row toolbar (under a quarter of the height), the Color
     field and its label on screen when focused and after its edit is
     acknowledged, and the menu behaviour above.
     `DesignCanvasTab.test.tsx` covers the compact toolbar at 320×225.
2. ~~**Label in name.**~~ **Done 2026-10-25.** Inspector fields were named by
   CSS property ("background-color" for visible "Fill"; WCAG 2.5.3).
   - `DesignStyleField` names its text field and preset combobox by the
     visible label (`aria-labelledby` its `<label>`); the icon buttons follow
     it ("Pick Fill", "Reset Fill", "Revert Fill", "Choose Display preset").
     The CSS property stays in `data-property` on the field, which
     `DesignInspector`'s own focus handling already used, and is the label's
     tooltip.
   - Tests updated in the same change: `DesignStyleField.test.tsx`,
     `DesignInspector.test.tsx` (its helper now finds a field by
     `data-property`, plus a test that the name is the label and not the
     property), `e2e/DesignCanvas.spec.ts` and
     `e2e/DesignCanvasAccessibility.spec.ts`, whose inspector ARIA snapshot
     now reads `combobox "Display"`, `textbox "Fill"` and so on and which
     checks with `toHaveAccessibleName` that every visible field is named by
     its label. No backend, MCP or bridge code addressed fields by name.
3. ~~**Enter on a row of a frame that has not rendered.**~~ **Done
   2026-10-25.** Enter only brought the frame into view; a second Enter
   selected, and nothing was announced.
   - `DesignCanvasTab` now remembers the layer, brings the frame into view
     and announces "Loading <frame>; the layer is selected when it appears".
     When the frame renders (`frameRendered`) it selects the layer. Any other
     selection, a frame selection or focusing another frame drops the wait;
     after 10 s (`PENDING_ELEMENT_MS`) it is dropped with "<frame> did not
     finish loading; nothing was selected".
   - Evidence: a new browser case culls Pricing, focuses its heading row
     (no iframe), presses Enter once and gets the announcement, the rendered
     frame, the inspector and the selected row (desktop) or the inspector
     drawer with focus (phone). The helper that waited for a rendered frame
     before every Enter is gone, so the journey now relies on the first
     Enter everywhere. Two unit tests in `DesignCanvasTab.test.tsx` cover the
     deferred selection (it fails without the fix) and the drop when another
     frame takes focus.

## Assumptions and decisions

- **How to fit the toolbar at 400% zoom.**
  - Options: (a) collapse the tools into an overflow menu below a height
    breakpoint; (b) let the open panel take over the pane (hide the canvas
    and toolbar) below the breakpoint; (c) make the toolbar scroll
    horizontally in one row.
  - Choice: (a), plus letting the short-pane inspector scroll as one column
    and hiding the Layers heading and filter note visually.
  - Why: it keeps every tool one Tab stop and a few arrows away, matches the
    todo's first suggestion, and needs no new mode for focus, Escape or the
    drawers. (b) would hide the canvas, which keyboard users still use for
    frame move and resize. (c) hides tools off-screen, which fails the same
    reflow criterion for whoever cannot see the scroll position.
  - Pros: one row of tools; the tree shows about three rows and the
    inspector a section heading, a label and its field at 320×225; no change
    above the breakpoint. Cons: tools take two more key presses in a short
    pane; the inspector's Apply bar scrolls with its fields there instead of
    staying pinned.
- **The breakpoint: 400 px of workspace height.**
  - Options: a viewport media query, a container height query, or the
    measured workspace height.
  - Choice: the measured workspace height (the same `ResizeObserver` that
    sets the narrow breakpoint), exposed as `data-short` for the CSS.
  - Why: the canvas is a pane inside the app, so the viewport says little,
    and the workspace's container is `inline-size` only. 400 px keeps 200%
    zoom of a 900 px-tall window (450 px) on the full toolbar and switches at
    about 300% and above. A height of 0 (not laid out, or hidden) is not
    short.
  - Pros: tracks the real pane, including split views. Cons: one more
    measured value; a pane resized across 400 px re-renders the toolbar.
- **Which controls stay inline when compact.**
  - Choice: Layers toggle, design name, inspector toggle (narrow panes) and
    the menu trigger.
  - Why: they open and close the panels the user needs room for, and the
    Layers toggle is where focus returns when a drawer closes.
- **Accessible names for inspector fields.**
  - Options: (a) the visible label alone, property in `data-property`;
    (b) "Label (property)", e.g. "Fill (background-color)"; (c) the label as
    name and the property as `aria-description`.
  - Choice: (a), with the property also as the label's tooltip.
  - Why: (b) and (c) satisfy 2.5.3 too, but add a second spoken name to more
    than 30 fields, and verbosity is already an open question for the human
    screen-reader pass in 0036. Tests and tooling keep a stable,
    language-independent handle in `data-property`.
  - Pros: shortest names, exactly what is shown. Cons: a screen-reader user
    who thinks in CSS does not hear the property; short labels such as
    "Size" and "Align" rely on their section (`region "Typography"`) for
    context.
- **Enter on an unrendered frame's row.**
  - Options: (a) select once the frame renders; (b) only announce why nothing
    was selected.
  - Choice: (a), announcing the wait as well, with a 10 s limit.
  - Why: one Enter should do what it says. The wait is dropped when the user
    selects something else or moves to another frame, so a late render never
    overrides a newer choice; moving between rows of the same frame keeps it,
    because the user is still in that frame.
  - Pros: no second Enter; the delay is announced. Cons: a pending selection
    can land a moment after the user has moved to another row of the same
    frame.
- **Test addressing.** The browser specs now address fields by visible label
  with `exact: true` (for example `getByRole("textbox", { name: "Color",
  exact: true })`, which does not match "Border color"); unit tests use
  `data-property`.

## Constraints and rationale

- Never weaken the focus watcher further: a stay on `<body>` shorter than two
  frames and 100 ms is tolerated only because Radix restores dialog focus
  from a zero-delay timer, which runs late on a loaded host.
- Layer-tree windowing must keep the focused and the selected rows mounted
  (the deliberate deviation from `react-virtuoso` recorded in
  [0036](0036-design-canvas-qualification.md#constraints-and-rationale)), and
  a culled frame keeps the chrome that holds focus.
- Radix menus move focus a task after an arrow key, so specs arrow through a
  menu with `arrowTo` (wait for focus to move before the next press), not
  `tabTo`; a too-fast loop overshoots and selects the wrong item.
- Menu items need stable keys: the zoom item's label changes with the zoom.

## Verification

All on 2026-10-25, macOS 27.0 arm64, Chromium via Playwright 1.64.

- `ORKESTRATOR_E2E_PORT=14254 bunx playwright test --config
  e2e/playwright.config.ts DesignCanvasAccessibility.spec.ts
  DesignCanvas.spec.ts --repeat-each 3 --workers 4` passed. After the last
  code change, the four design component specs
  (`DesignCanvasAccessibility`, `DesignCanvas`, `DesignHistoryLayout`,
  `DesignLaunchDialog`) passed with `--repeat-each 2 --workers 4`.
- `bun test --cwd apps/web ./src/components/design` passed (the canvas-tab
  file: 21 tests, three new). A mutation check (the pending selection never
  consumed) failed the new deferred-selection unit test as expected.
- `mise run lint`, `mise run typecheck` and `mise run format:check` passed.
- `mise run test`: the final run passed the web, root, bridge and protocol
  groups; the backend failed two known aggregate-load timeouts in untouched
  code at load 55–66, both of which passed alone (recorded as recurrences of
  flakes
  [0165](../../tests/flaky-tests/coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md)
  and
  [0785](../../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md)).
  An earlier run caught a new `queryBy… ).toBeNull()` assertion that the
  repository's diagnostic-bounds rule forbids; it was rewritten.
- `mise run test:agent:design:isolated` (the real-stack design suite on a
  disposable profile) passed in 90.8 s.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md)
  holds the screen-reader pass and the evidence. WCAG 2.5.3 is defined on
  the accessible name, which the spec checks in Chromium's accessibility
  tree; no speech-input product (Voice Control, Dragon) was driven, and that
  run is optional confirmation, not open work.
- [design-canvas.md](../../architecture/design-canvas.md#client) describes
  the shipped behaviour.
- [0732-duplicate-todo-numbers-unguarded.md](../cross-cutting/0732-duplicate-todo-numbers-unguarded.md): the duplicate 0054 number and the missing guard, split out.
