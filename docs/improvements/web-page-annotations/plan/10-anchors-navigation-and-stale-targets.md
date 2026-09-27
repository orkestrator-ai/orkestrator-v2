# 10 — Anchors, navigation, and stale targets

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 04, 05, 09. Milestone: B.

## Deliverable

Make saved pins useful after page reloads, DOM edits, scrolling, and navigation.
When a target cannot be identified confidently, retain the historical evidence
and ask for reselection instead of moving the pin to a plausible but wrong node.

## Code ownership

Extend the shared target/capture contract and extract proposed page-runtime
anchor helpers from `browser-preview-annotation-script.ts`. Add a bounded host
resolver interface through the preview manager and typed adapter. Keep live
element handles inside the preview lifecycle; persistence stores descriptions.

Reuse address/gateway resolution from `apps/web/src/lib/browser-address.ts` and
the preview manager's navigation scope checks. Resolve logical routes against
the owning environment, not whichever environment happens to be active.

## Capture anchor candidates

- [ ] Collect a stable ID/test ID candidate only if unique within the relevant
  document/root. Duplicate IDs are not a unique locator.
- [ ] Add scoped semantic role/name, normalized visible text and short surrounding
  text, bounded ancestor descriptors, a CSS path, and geometry as supporting
  context. Bound candidate counts and encoded size using step 01.
- [ ] Record scope/root information separately. In this step, unsupported
  iframe/shadow boundaries return unsupported; do not pretend a top-level
  selector addresses their internal nodes.
- [ ] Normalize whitespace for comparison without changing the stored original
  text. Keep rendered visibility separate from raw `textContent`.
- [ ] Persist the original locator description and capture. A later successful
  match updates ephemeral placement, not the historical evidence.

## Deterministic resolution rules

Define a resolver result containing state, matched rule, candidate count,
document generation, and current rectangle if matched. Use ordered rules with
corroborating identity checks rather than a weighted score with an arbitrary
confidence threshold.

1. Confirm logical service/route and supported root scope. If different, mark
   the pin off-page; do not query a selector on an unrelated route.
2. Try unique stable ID/test ID with compatible tag/semantic identity. A reused
   ID with changed role or substantially different text is a stale candidate.
3. Try a scoped semantic identity plus surrounding/ancestor context. Exactly one
   corroborated candidate may match; repeated labels remain ambiguous.
4. Try the original structural path only with supporting text/identity. A unique
   `nth-of-type` path alone cannot distinguish a reordered repeated card.
5. If no rule finds one corroborated node, return missing/ambiguous/stale and
   offer manual reselection. Geometry alone never establishes DOM identity.

Treat an intentionally changed label as potentially stale; the user can accept
the new target explicitly. Conservative reselection is preferable to reporting
that a different button was fixed. Keep matching rules explainable in diagnostics
without logging the selector or text.

## Live pin lifecycle

- [ ] Draw pins/highlights only for currently matched targets. Put missing and
  off-page pins in the trusted panel with their original thumbnails.
- [ ] Recalculate placement on scroll/resize and invalidate identity on document
  generation changes, relevant DOM replacement, and hot reload.
- [ ] Use a bounded/coalesced observer schedule. Resolve only a visible page of
  pins, initially at most 50; pause work while hidden. A busy page must not create
  unbounded mutation records, scans, or layout reads.
- [ ] Avoid repeatedly scanning all DOM nodes on pointer movement. Apply a
  traversal budget, deadline, and explicit unsupported/too-complex outcome.
- [ ] Subscribe to change hints before loading current annotation summaries.
  Rehydrate pins from backend records after navigation or tab remount.
- [ ] Never change a request's frozen target when its live pin moves or reanchors.

## Navigation and reselection

- [ ] **Show on page** validates/opens the logical route using current preview
  routing, waits for the document, resolves the anchor, then scrolls/highlights.
  It does not replay a form submission or arbitrary interaction sequence.
- [ ] If sanitized URL state is incomplete, authentication expired, or service
  routing changed, ask the user to navigate and reselect. Do not reuse secrets
  from an old URL or assume that a screenshot proves current page identity.
- [ ] **Reselect target** starts capture for the existing annotation and commits
  a new capture/content revision after user save. Preserve old capture/results.
- [ ] Show when an active request refers to older evidence. Reselection does not
  mutate that request or implicitly send a steering message.
- [ ] Imported `legacy-unresolved` annotations become structured only through
  this explicit new capture; retain imported text for historical context.

## Verification

- [ ] Unit fixtures cover duplicate IDs, repeated button names, card reorder,
  inserted siblings, dynamic class names, label changes, removed targets,
  route changes, hash routes, and ID reuse by a different component.
- [ ] Browser tests cover hot reload, late-loading fonts/layout shift, scroll,
  preview zoom/device scaling, modal targets, and offscreen elements.
- [ ] Verify mismatches produce explicit states, never a plausible wrong match.
  Record the rule/result counts as content-free diagnostics.
- [ ] Test a page with thousands of mutations/nodes and many stored annotations;
  observer queues and resolver work stay within documented bounds.
- [ ] Reselect while implementation runs, then receive its old result; current
  evidence remains intact and old acceptance requires explicit handling.

Done when reload/navigation can recover supported targets and every uncertain
match stays visibly attached to its original evidence without automatic retargeting.
