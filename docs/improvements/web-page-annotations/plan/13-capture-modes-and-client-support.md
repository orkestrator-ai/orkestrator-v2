# 13 — Additional capture modes and client support

Status: Not started. Depends on: 10–12. Milestone: C.

## Deliverable

Expand selection to text, visual regions, and page-level feedback, and provide
honest capability-based behavior on clients without native capture. Keep the
same annotation/request/review model across all supported surfaces.

## Shared contract and UX changes

- [ ] Enable target variants already reserved in step 01 and add per-mode
  validators, labels, keyboard controls, and capture fixtures.
- [ ] Offer a compact selection-mode picker with **Element**, **Text**,
  **Region**, and **Page** only when supported. Preserve the chosen mode for
  the current review session, not as an undocumented global change.
- [ ] Reuse trusted comment authoring, pending capture acknowledgement, evidence
  storage, destination selection, and dispatch. No mode sends work implicitly.
- [ ] Explain target precision: element/text may reanchor; region is tied to
  captured pixels; page notes intentionally have no individual element.

## Text-range selection

- [ ] Capture exact selected text, bounded prefix/suffix context, containing
  element anchors, range endpoints where useful, and geometry/viewport.
- [ ] Use text plus surrounding context to re-resolve after DOM restructuring.
  Positional offsets alone cannot identify the same text after edits.
- [ ] Handle multiline, nested inline elements, repeated phrases, Unicode,
  bidirectional text, and selections that exceed the text budget.
- [ ] Reject or explicitly fall back for ranges spanning unsupported roots or
  hidden/sensitive form contents. Never capture unrelated selection text from
  outside the preview or copy it to the system clipboard as a side effect.
- [ ] Provide keyboard selection-to-note flow and a clearly labelled target
  when a requested copy edit intentionally makes the old quote disappear.

## Region selection

- [ ] Allow a bounded drag rectangle and keyboard adjustments in trusted/native
  capture UI. Preserve CSS/image coordinate transforms from step 04.
- [ ] Store the region, source screenshot, crop relation, and capture metadata.
  A crop must reference its parent capture so adjacent context is recoverable.
- [ ] Use this for whitespace, canvas, inaccessible iframe content, or visual
  defects without a useful DOM element. Label it as visual evidence with no
  inferred source-file or stable DOM identity.
- [ ] After layout/viewport changes, mark the region historical and offer
  recapture. Do not place the old rectangle on new pixels as if it still names
  the same target.
- [ ] Support redaction and screenshot exclusion consistently. Bound crop/image
  allocations, and keep region-selection interaction separate from normal page
  gestures or touch scrolling.

## Whole-page and responsive feedback

- [ ] A page note captures logical route, viewport, and a bounded viewport image
  or text-only context. It need not capture an unbounded full-page screenshot.
- [ ] Add optional responsive capture sets with separately recorded viewport,
  route, time, and document generation for each image. Share one annotation
  intent but do not pretend those images were simultaneous.
- [ ] Require explicit user action before changing preview viewport or page
  state. Restore prior preview geometry when the capture workflow ends.
- [ ] Enforce the same aggregate evidence budget for responsive sets. Offer
  selection/splitting when several images exceed model or transport capacity.

## Frame and shadow boundaries

Add support incrementally only where the inspection transport can prove scope
and provenance. Open shadow roots and same-origin frames require explicit root
paths and navigation generations, plus coordinate transforms through each frame.
Closed roots and inaccessible cross-origin frames remain unsupported for DOM
inspection; offer region capture instead.

- [ ] Bound root depth, frame count, traversal time, and transformed geometry.
- [ ] Revalidate each frame/root on navigation and capture; a frame index alone
  cannot name the same document after replacement.
- [ ] Do not weaken preview sandbox or origin isolation for selector access.
  Do not expose a generic page-script execution endpoint as the annotation API.
- [ ] If a privileged desktop inspection route is proposed, review its narrow
  command set, actual sender identity, scope, and negative tests before enabling.

## Client capability rollout

| Surface | Baseline capability | Additional work before capture can be advertised |
| --- | --- | --- |
| Electron desktop | Native capture and all implemented discussion/review actions. | Validate platform-specific native composition and image scaling. |
| Authenticated web client | Read/write saved feedback, target an agent, follow progress, review existing images. | A narrowly scoped preview inspection/capture transport with authenticated sender and route/document binding. |
| iOS wrapper | Same shared discussion/review contract where layout supports it. | Explicit native or scoped preview capture bridge, touch/keyboard behavior, and platform validation. |
| Older client/backend | Negotiated supported subset. | Versioned upgrade; never enable buttons based on user-agent string alone. |

For non-desktop capture, first document a short design decision comparing a
trusted preview bridge with a backend-owned browser session. Choose only a
method that can preserve the actual page state or clearly disclose a separate
session. Do not import the user's cookies/credentials into another browser
implicitly. This decision is a prerequisite for enabling that capability, not
a reason to block shared discussion/review support.

If neither transport can satisfy the scope and state guarantees, ship that
client with capture explicitly unavailable and saved-feedback features working.
Record the unsupported matrix entry as deferred rather than claiming parity.

## Verification and completion

- [ ] Test each target mode's geometry, persistence, prompt summary, review label,
  keyboard behavior, and stale-target semantics.
- [ ] Exercise repeated text, nested roots, frame reload, transformed/scrolled
  frames, canvas content, narrow screens, touch input, and high-DPI captures.
- [ ] Verify web/iOS can review desktop-created feedback without a live desktop
  connection, while unsupported capture remains honestly disabled.
- [ ] Test forged frame messages, wrong origin/window/document, stale replies,
  excessive payloads, and requests outside the owning environment.
- [ ] Run applicable gate C client checks in step 14; update the capability
  matrix with actual tested support and explicit deferrals.

Done when every enabled capture mode has the same persistence/trust/review
guarantees and clients expose only capabilities their transport can support.
