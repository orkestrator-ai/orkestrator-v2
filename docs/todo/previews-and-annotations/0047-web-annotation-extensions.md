# Web annotation extensions

Checked against `main` at `2459b05c` (2026-10-15).

These are optional annotation capabilities that the proposal and plan put off
until the core loop was reliable: controlled pixel diffs, automatic
after-capture, development source hints, DOM targets inside shadow roots and
iframes, capture outside the desktop app, and a few product extensions. None
of them blocks the shipped workflow. Each should arrive behind its own
capability flag, the way `WebAnnotationCapabilities.operations.comparison` and
`.resultTools` gate the existing surfaces. Qualify the core loop first
([0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)).

## Current state

- Comparison is side by side only. Capture current result
  (`web_annotation_result_capture`) stores a new immutable after-capture with
  `WebAnnotationComparisonMetadata`: the compared capture, `targetMatch`, and
  labelled route, viewport and target `differences`. `ResultReview.tsx` shows
  the two images. The desktop capture waits for a settle window and reports
  `stable`/`unstable` (`browser-preview-capture.ts`). Pixel diffs and overlays
  are never advertised.
- `WebAnnotationSourceHint` (`producer`, `path`, `line`, `component`,
  `verified`) exists in the contract and in validation (at most four per
  capture). `compileWebAnnotationBrief` (`web-annotation-brief.ts`) renders it
  as "candidate location only; verify in the repository". Nothing produces
  hints, and the backend never sets `verified: true`.
- iframe and shadow-root targets resolve to their host element with
  `scope: { kind: "unsupported", reason: … }`
  (`browser-preview-anchor-script.ts`). Region mode (`CaptureModePicker.tsx`)
  is the documented fallback for iframe, shadow and canvas content.
- Only Electron captures. Web and iOS list, reply, request and review, and
  hide capture (`canCapture` in `AnnotationPanel.tsx`). The architecture doc's
  client capability matrix records this.
- A thread summary for a different session is a deterministic excerpt
  (`web-annotation-thread-summary.ts`, `THREAD_SUMMARY_LIMITS`: 8 entries, up
  to 2,400 characters). It goes inside the untrusted evidence envelope and
  never replaces the latest human instruction.
- Responsive capture sets already exist
  (`browser-preview-capture-responsive.ts`, `ResponsiveCaptureControl.tsx`).

## Outstanding work

### Code

1. Controlled pixel or region diffs, with an optional overlay.
   - Enable only when route, viewport, zoom and DPR match and an
     unstable-region mask exists.
   - Show the measurement as advisory evidence, never as pass/fail or a
     resolution rule.
   - Cap decode memory and comparison time. Reject incompatible captures
     instead of resizing them, which would hide layout differences.
   - Advertise it through its own capability, separate from `comparison`.
2. Automatic after-capture. Allowed only when it can neither navigate nor
   reload the user's active page. Reuse the stable-geometry window, reapply the
   user's redaction masks, and keep manual capture as the path whenever login
   or form state cannot be reproduced.
3. Development source hints.
   - Needs a producer that identifies itself and its project root.
   - Before `verified: true`, the backend checks containment and existence.
     Extend `web-annotation-source-checks.ts`, including the container case in
     [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md).
   - Hints stay candidate locations; the agent still checks the repository.
   - Never depend on private React (or other framework) runtime internals.
4. Open shadow roots and same-origin iframes.
   - Requires explicit root paths, a navigation generation per frame, and
     coordinate transforms through each frame.
   - Bound depth, frame count, traversal time and transformed geometry.
     Revalidate each root on navigation and on capture; a frame index alone
     does not name the same document after replacement.
   - Closed roots and cross-origin frames stay Region-only.
   - Never weaken the preview sandbox or origin isolation, and never expose
     generic page-script execution as the annotation API. Any privileged
     desktop inspection route needs a reviewed narrow command set, a checked
     sender identity and negative tests before it is enabled.
   - Extend the ordered rules in
     [web-page-annotations.md](../../architecture/web-page-annotations.md)
     §"Resolution rules" rather than adding a score.
5. Non-desktop capture.
   - Start with a short design decision that compares a trusted preview bridge
     with a backend-owned browser session. The chosen method must either keep
     the real page state or clearly disclose that it is a separate session. It
     must never import the user's cookies or credentials implicitly.
   - It shares its surfaces with
     [0046-embedded-service-previews.md](0046-embedded-service-previews.md). An embedded
     web or iOS preview is the likeliest host for a bridge, and its
     `postMessage` and sandbox rules apply. Never inject privileged scripts
     into arbitrary application pages.
   - Until then, web and iOS keep capture unavailable, as they do today.
     Record that in the capability matrix as a deferral, not as parity.
6. Product extensions, each needing its own design:
   - shared-component grouping of notes;
   - issue-tracker export;
   - multi-user discussion, which needs identity and permissions first;
   - generated, attributed thread summaries, which must never replace the
     latest human instruction.

### Qualification

- For each extension that lands: synthetic pages with deterministic changes,
  animation, late fonts, mismatched viewports, an expired login and failed
  functional checks. For frame and shadow support, add forged frame messages,
  wrong origin, window or document, stale replies, excessive payloads, and
  requests from outside the owning environment.

## Constraints and rationale

- Visual acceptance stays separate from functional checks. An unchanged image
  does not prove functional equivalence, and a passing test does not prove
  visual acceptance at the user's viewport.
- A result tool reports work and never accepts it. Only a human resolves.
- The plan's scope boundaries still apply: no inspection of arbitrary
  third-party sites; no automatic commits, PRs or approvals; no code
  generation from private framework internals. Temporary DOM edits are not an
  implementation.
- Fresh captures are new immutable assets. Repeat reviews never overwrite the
  original screenshot or another result's evidence, and redactions apply to
  after-images too.

## Open questions

- Which extension, if any, is wanted next?
- Is non-desktop capture worth designing before embedded previews exist? If
  embedded previews are dropped, a backend-owned browser session is the only
  remaining option.

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md),
  [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md).
- [0046-embedded-service-previews.md](0046-embedded-service-previews.md) (web iframe and
  iOS `WKWebView` surfaces).
- [web-page-annotations.md](../../architecture/web-page-annotations.md)
  §"Client capability matrix" and §"Known limitations".
- The design canvas renderer is a precedent for a bounded worker only. Its
  isolated authored HTML is not the user's authenticated application session
  ([design-canvas.md](../../architecture/design-canvas.md)).

## Replaces

- `docs/improvements/web-page-annotations.md` (P2: responsive sets, which
  shipped, plus shared-component grouping, richer diffs, issue export,
  source-location instrumentation, multi-user discussion)
- `docs/improvements/web-page-annotations/plan/00-index.md` (scope
  boundaries)
- `docs/improvements/web-page-annotations/plan/12-results-and-visual-verification.md`
  (pixel diffs, overlay, automatic capture, source hints)
- `docs/improvements/web-page-annotations/plan/13-capture-modes-and-client-support.md`
  (frame and shadow boundaries, non-desktop capture)
