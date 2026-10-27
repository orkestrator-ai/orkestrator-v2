# Web annotation extensions

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pick the next extension**: the first open question, which extension (if
   any) to build next. Status: open.
2. **Controlled pixel diffs**: code item 1, advisory region or pixel diffs
   behind their own capability. Status: deferred.
3. **Automatic after-capture**: code item 2. Status: deferred.
4. **Development source hints**: code item 3, a producer plus backend
   verification; also a small trust gap in today's hint handling. Status:
   deferred (the gap is open now).
5. **Open shadow roots and same-origin iframes**: code item 4. Status: deferred.
6. **Non-desktop capture**: code item 5 and the second open question. Status:
   blocked (on the go or no-go decision in
   [0046](0046-embedded-service-previews.md)).
7. **Product extensions**: code item 6 (grouping, issue export, multi-user,
   generated summaries). Status: deferred.

The Qualification bullet applies to each extension as it lands and is covered
inside tasks 2 to 6.

### 1. Pick the next extension

**Problem.** Six optional extensions are listed with no order, so none starts.

**Context.** The file says to qualify the core loop first
([0044](0044-web-annotation-qualification.md)); 0044 still has a remote backend,
the iOS wrapper and native focus runs open. 0043 is finished.

**Investigation.** None of the six has started. The capability gates the file
cites still exist: `operations.resultTools` and `operations.comparison` in
`WebAnnotationCapabilities` (`packages/protocol/src/web-annotations.ts:1101-1102`).
Responsive capture sets have shipped
(`apps/desktop/electron/browser-preview-capture-responsive.ts`,
`apps/web/src/components/browser/annotations/ResponsiveCaptureControl.tsx`).

**Decisions.**

- **Which extension first?**
  - **Source hints (recommended).** Task 4.
    - Pros: contract, validation, brief rendering and the path checker already
      exist; closes a latent trust gap at the same time; directly helps agents
      find code.
    - Cons: needs a dev-time producer per framework, which drifts with
      framework versions.
  - **Pixel diffs.** Task 2.
    - Pros: visible reviewer value on top of the existing side-by-side view.
    - Cons: decode-memory and mask work; easy to misread as pass or fail.
  - **None until 0044 closes.**
    - Pros: follows the file's "qualify the core loop first".
    - Cons: 0044's remaining runs need hardware and may take a long time.

### 2. Controlled pixel diffs

**Problem.** Comparison is side by side only, so a reviewer eyeballs small
changes.

**Context.** Enable only on matching route, viewport, zoom and DPR plus an
unstable-region mask; advisory only; bounded decode; own capability.

**Investigation.** `WebAnnotationComparisonMetadata` carries `differences`
(`packages/protocol/src/web-annotations.ts:386`, `:1035`), and the desktop
settle window reports `stable`/`unstable`
(`apps/desktop/electron/browser-preview-capture.ts:14`, `:191`, `:514`).
No diff code exists; `ResultReview.tsx` shows two images. There is no
unstable-region mask today, only a whole-capture stable flag.

**Decisions.**

- **Where should the diff run?**
  - **Backend, on stored assets with byte and time caps (recommended).**
    - Pros: one implementation for every client, including review on web and
      iOS; assets are already there.
    - Cons: decode cost in the backend process; needs a worker or strict caps.
  - **In the client at view time.**
    - Pros: no backend cost.
    - Cons: per-client code; iOS and web would differ.
- **Where does the unstable-region mask come from?**
  - **Sample the region twice during the existing settle window
    (recommended).**
    - Pros: reuses the capture path; no user effort.
    - Cons: misses slow animations.
  - **User-drawn mask.**
    - Pros: exact.
    - Cons: friction on every comparison.

### 3. Automatic after-capture

**Problem.** The reviewer must press Capture current result by hand after each
agent turn.

**Context.** Allowed only if it can neither navigate nor reload the active
page; reapply redaction masks; manual capture stays the path when login or form
state cannot be reproduced.

**Investigation.** `web_annotation_result_capture` and the settle window exist
(see task 2). Nothing triggers a capture automatically.

**Decisions.**

- **What triggers it?**
  - **Offer a one-click prompt on the request card at turn end
    (recommended).**
    - Pros: no navigation risk; the user stays in control of the page state.
    - Cons: still one click.
  - **Capture silently on turn end if the tab is on the same route.**
    - Pros: fully automatic.
    - Cons: captures mid-edit or logged-out states; a background tab may have
      changed since.

### 4. Development source hints

**Problem.** Agents get no source location for an annotated element.

**Context.** Needs a self-identifying producer and project root; the backend
checks containment and existence before `verified: true`; never private
framework internals.

**Investigation.** `WebAnnotationSourceHint` is at
`packages/protocol/src/web-annotations.ts:310`, validation at
`packages/protocol/src/web-annotations-validation.ts:252-263` (at most four).
Nothing in `apps/` produces hints. Newly found: validation accepts any boolean
`verified`, the capture write stores `input.evidence` unchanged
(`apps/backend/src/core/web-annotation-service-threads.ts:415`), and the brief
spreads each hint (`...hint`) into the agent's evidence
(`apps/backend/src/core/web-annotation-brief.ts:365-370`). So a client can
submit `verified: true` and the agent sees it, albeit with the "candidate
location only" note. The file's claim "the backend never sets `verified: true`"
holds, but the backend does not reset a client's `true` either.

**Decisions.**

- **Close the `verified` gap now, ahead of the feature?**
  - **Yes: force `verified: false` on write (or refuse `true`) until the
    backend check exists (recommended).**
    - Pros: matches the receiver-assigned provenance rule used for
      `regionCrop` and `producerSource` in 0043; tiny change.
    - Cons: a new todo file is needed (README: no new items in an existing
      file).
  - **Leave it; the brief note already says to verify.**
    - Pros: no change.
    - Cons: a forged `verified: true` reaches the agent, contrary to the trust
      model.
- **What produces hints?**
  - **A documented dev-server convention such as `data-source-path`
    attributes from build plugins (recommended).**
    - Pros: no framework internals; works across frameworks that emit it.
    - Cons: needs project opt-in.
  - **Read React DevTools fibre data.**
    - Pros: zero project setup for React.
    - Cons: explicitly forbidden (private internals).

### 5. Open shadow roots and same-origin iframes

**Problem.** Elements inside shadow roots or iframes resolve to their host
element; Region mode is the only fallback.

**Context.** Needs root paths, a per-frame navigation generation, coordinate
transforms, bounds, and no weakening of the sandbox. Extend the ordered
resolution rules rather than add a score.

**Investigation.** The anchor script still marks these `unsupported` with a
reason of `iframe`, `shadow-root`, `closed-root` or `cross-origin`
(`apps/desktop/electron/browser-preview-anchor-script.ts:167`, `:701-707`).
`CaptureModePicker.tsx` offers Region.

**Decisions.**

- **Which first?**
  - **Open shadow roots (recommended).**
    - Pros: same document, no frame generations or cross-frame messaging;
      common in web-component apps.
    - Cons: still needs root-path anchors and resolution-rule changes.
  - **Same-origin iframes.**
    - Pros: covers embedded tools and editors.
    - Cons: per-frame generations and transforms; the riskiest part of the
      item.

### 6. Non-desktop capture

**Problem.** Web and iOS can review but not capture.

**Context.** Needs a design choice between a trusted preview bridge and a
backend-owned browser session; must never import cookies implicitly. Shares
surfaces with 0046.

**Investigation.** Capture is gated by `canCapture`
(`apps/web/src/components/browser/annotations/AnnotationPanel.tsx:70`). 0046
has not started, so no embedded host for a bridge exists.

**Decisions.**

- **Which design to pursue?**
  - **Wait for 0046's go or no-go, then design (recommended).**
    - Pros: avoids designing a bridge for a surface that may never exist.
    - Cons: no non-desktop capture for the foreseeable future.
  - **Backend-owned browser session now.**
    - Pros: independent of 0046; the artifact preview worker already runs
      Playwright.
    - Cons: a separate session without the user's login state, which must be
      disclosed and is often useless for authenticated apps.

### 7. Product extensions

**Problem.** Grouping, issue export, multi-user discussion and generated
summaries are wanted but undesigned.

**Context.** Each needs its own design; multi-user needs identity first;
summaries must never replace the latest human instruction.

**Investigation.** Thread summaries for another session are deterministic
excerpts (`THREAD_SUMMARY_LIMITS`,
`apps/backend/src/core/web-annotation-thread-summary.ts:13`). Nothing else
exists.

**Decisions.**

- **Keep these here or split them out?**
  - **Move each to its own todo file when someone wants it, and drop it from
    this list then (recommended).**
    - Pros: each needs separate design and rating; keeps this file about
      capture and evidence.
    - Cons: the list here stays as a placeholder until then.
  - **Keep them bundled here.**
    - Pros: one place to look.
    - Cons: an undesigned grab-bag that keeps the file permanently unfinished.

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
     Reuse `web-annotation-source-checks.ts`, which checks local worktrees and
     (since [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md))
     container workspaces.
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
- [0725-annotation-source-hint-client-verified.md](0725-annotation-source-hint-client-verified.md):
  the client-declared `verified: true` gap found in task 4.
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
