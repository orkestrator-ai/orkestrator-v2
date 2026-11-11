# Web annotation extensions

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; statuses rechecked
2026-10-30 against `main` at `cd7bbe3e`, and task 5 on 2026-11-02 against
`main` at `38d55ee1`.

Checked against `main` at `2459b05c` (2026-10-15).

### Tasks

1. **Pick the next extension**: the first open question, which extension (if
   any) to build next. Status: done (source hints, task 4; see Assumptions and
   decisions).
2. **Controlled pixel diffs**: code item 1, advisory region or pixel diffs
   behind their own capability. Status: open (not started; still no diff code
   on 2026-10-30).
3. **Automatic after-capture**: code item 2. Status: open (not started).
4. **Development source hints**: code item 3, a producer plus backend
   verification; also a small trust gap in today's hint handling. Status:
   done (the gap closed in todo 0725, #1416; the producer, backend check and
   `operations.sourceHints` capability landed on branch
   `todo-0047-web-annotation-extensions`).
5. **Open shadow roots and same-origin iframes**: code item 4. Status: open
   (open shadow roots done on 2026-11-02 on branch
   `shadow-root-annotations-583af4c65646-r1`; same-origin iframes not
   started; the follow-ups in 2580 (retired 2026-11-11) are done).
6. **Non-desktop capture**: code item 5 and the second open question. Status:
   blocked (waits on 7568: 0042 task 3, per the embedding deferral recorded
   by [0046](0046-embedded-service-previews.md) task 1 on 2026-10-30; the
   embedded host remains unimplemented).

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
(`apps/backend/src/core/web-annotations/service-threads.ts:415`), and the brief
spreads each hint (`...hint`) into the agent's evidence
(`apps/backend/src/core/web-annotations/brief.ts:365-370`). So a client can
submit `verified: true` and the agent sees it, albeit with the "candidate
location only" note. The file's claim "the backend never sets `verified: true`"
holds, but the backend does not reset a client's `true` either.

Rechecked 2026-10-30: todo 0725 (#1416) closed that gap. A capture declaring
`verified: true` is refused ("Source hint verification is assigned by the
receiver", `packages/protocol/src/web-annotations-validation.ts`), and hints
are stored and briefed through `webAnnotationSourceHintFields`. The
`regionCrop`/`producerSource` pattern it follows is the same. The remaining
work, the producer and the backend check, is what this branch builds.

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

Rechecked 2026-11-02 against `main` at `38d55ee1`: still true. `scopeFor`
marked an element with a `shadowRoot` (the host) and any element whose root
was not the document `unsupported`, and Element mode only asked
`document.elementsFromPoint`, which retargets a hit inside a shadow root to
its host, so content inside a root could not be picked at all. The resolver
refused every non-document scope. Electron main does not filter scopes; it
passes anchors to the page. A document-level `MutationObserver` (the pin
layer's only observer) does not see changes inside shadow roots. Open shadow
roots were built on this date; see Assumptions and decisions.

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
(`apps/web/src/components/browser/annotations/AnnotationPanel.tsx:70`). On
2026-10-30, 0046 task 1 decided to defer embedding until top-level Safari and
iOS pass in [0042](0042-service-preview-rollout.md) task 3, which remains
blocked on macOS Safari and iOS hardware. 0046's embedded surfaces remain
unimplemented, so no embedded host for a bridge exists.

**Decisions.**

- **Which design to pursue?**
  - **Keep capture blocked under 0046's recorded deferral; revisit after
    0042 task 3 passes (recommended).** The trusted-bridge option still needs
    an implemented embedded host in 0046.
    - Pros: avoids designing a bridge for a surface that may never exist.
    - Cons: no non-desktop capture for the foreseeable future.
  - **Backend-owned browser session now.**
    - Pros: independent of 0046; the artifact preview worker already runs
      Playwright.
    - Cons: a separate session without the user's login state, which must be
      disclosed and is often useless for authenticated apps.

These are optional annotation capabilities that the proposal and plan put off
until the core loop was reliable: controlled pixel diffs, automatic
after-capture, development source hints, DOM targets inside shadow roots and
iframes, capture outside the desktop app, and a few product extensions
(whether any is wanted is in the manual-test checklist). None of them blocks
the shipped workflow. Each should arrive behind its own
capability flag, the way `WebAnnotationCapabilities.operations.comparison` and
`.resultTools` gate the existing surfaces. Qualify the core loop first
([0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)).

## Assumptions and decisions

Recorded 2026-10-30 by the worker on branch
`todo-0047-web-annotation-extensions`, against `main` at `cd7bbe3e`.

### Task 1: build source hints next (the recommendation)

Chose source hints, as recommended. Current main supports it: the contract,
validation, brief rendering and `checkWebAnnotationWorkspacePaths` (local
worktrees and container `/workspace`) all exist, and 0725 (#1416) already
refuses a client-declared `verified: true`. That leaves the producer and the
receiver-side check, both small. Pixel diffs still need an unstable-region
mask that does not exist (only a whole-capture stable flag) and decode caps in
the backend. "None until 0044 closes" was rejected because 0044's remaining
runs wait on hardware and a person, and source hints do not change the core
loop that 0044 qualifies.

### Task 4: rechecked status of the trust gap

The gap in this task's investigation (a client's `verified: true` reaching the
agent) is closed on main by todo 0725 (#1416, commit `17747a12`). Not redone.

### Task 4: the producer is a documented page convention read by the desktop

Chose the recommended `data-orkestrator-source` attribute convention
(`WEB_ANNOTATION_SOURCE_ATTRIBUTES` in `packages/protocol/src/web-annotations.ts`).
The producer identifies itself with an optional
`<meta name="orkestrator-source-producer">` (default: the attribute name) and
its project root with an optional `<meta name="orkestrator-source-root">`
(workspace-relative; default: the workspace root). The desktop anchor script
(`sourceHintsFor`) walks the selected element and up to 16 ancestors and keeps
the nearest four distinct paths. Only workspace-relative paths are accepted:
an absolute path would reveal or need the host's worktree path, and a page
cannot know it. React DevTools fibre data was rejected, as the analysis says,
because it is a private internal. Only element captures carry hints; text,
region and page captures have no single element to read.

### Task 4: `verified` is set before the write, from a real workspace check

`verifySourceHints` (`web-annotation-service-threads.ts`) runs after
validation and before the write queue, on `create`, `capture_replace` and
`result_capture`, through a new shared `WebAnnotationContext.checkWorkspacePaths`
(moved from the result-report path, which now uses it too). It sets
`verified: true` only for paths whose status is `exists`. A missing,
outside-workspace (including a symlink that resolves outside) or unchecked
path, or a failed check, leaves the hint unverified and still saves the note:
a hint is optional evidence and should never block feedback. The check runs at
capture time and is stored in the immutable capture, so `verified` means "the
path existed in the workspace at capture". The brief says so and still tells
the agent to check the code. Line and component are never confirmed, because
the check never reads file contents.

### Task 4: the capability is `operations.sourceHints`, gated on the check

The backend advertises `operations.sourceHints` when authoring is on and the
dispatch port has `checkWorkspacePaths`, so it never invites hints it cannot
check. The renderer drops hints at commit (`withAdvertisedSourceHints` in
`apps/web/src/lib/web-annotations/capture-commit.ts`) unless the flag is
`true`, so an older backend never receives them. The flag is optional in the
contract, so older clients ignore it.

### Task 4: defence in depth in Electron main

Main rebuilds each page-declared hint from its known fields, forces
`verified: false`, checks `isSafeRelativePath`, and drops an invalid hint on
its own instead of failing the whole capture (`parseSourceHints`). The page is
untrusted and could patch the anchor kit, so main does not rely on the page's
own filtering.

### Task 4: follow-ups completed; remaining qualification moved

The documented reference emitter and thread source-candidate display shipped
through to-do 0950 (deleted 2026-11-06; evidence remains in git history).
macOS local/container captures ran there. Remaining Linux captures, a real
Vite dev-pipeline capture and the disposition of other Babel integrations are
open in [0044 task 8](0044-web-annotation-qualification.md#8-source-hint-capture-off-macos-and-on-a-real-dev-server).
Windows remains unrun and out of the current support scope under 0042 D18,
as recorded in that task.

### Task 4: retirement review correction (2026-11-06)

Point to the living qualification task instead of the deleted implementation
file. Shipping the emitter and display does not close the remaining captures.

### Tasks 2, 3, 5, 6 and 7: statuses rechecked, nothing built

Rechecked on 2026-10-30: no diff code exists and `ResultReview.tsx` still
shows two images (task 2); nothing triggers an after-capture (task 3); the
anchor script still marks iframe and shadow-root targets `unsupported`
(task 5); non-desktop capture follows 0046's recorded embedding deferral
until 0042 task 3 passes (task 6); none of the product extensions has started
(task 7). Their statuses now read `open`, as `AGENTS.md` asks, with the reason
or dependency in brackets.

### Task 6: retain the block under the recorded embedding deferral

Updated 2026-10-30 to follow 0046 task 1's decision: revisit after 0042 task 3
passes, with an implemented embedded host still required for a trusted bridge.
Kept non-desktop capture blocked rather than choosing a backend-owned browser
session, because the recorded deferral does not choose that separate-session
design. The embedding go or no-go is no longer an outstanding decision.

### Task 5: open shadow roots first, as recommended

Built open shadow roots only, on branch
`shadow-root-annotations-583af4c65646-r1` (2026-11-02). Same-origin iframes
were not started: they need per-frame navigation generations, coordinate
transforms and cross-frame messaging, and nothing in the shadow-root work
depends on them. Task 5 stays `open` for them.

### Task 5: the anchor records a root path, not a composed selector

A new scope `{ kind: "shadow", hosts }` (`WebAnnotationAnchorScope`) lists
each open shadow root's host, outermost first, as its tag, a stable id when
unique in the containing root, and a CSS path within that root. The rest of
the anchor (stable id, semantics, CSS path) is scoped to the innermost root.
Considered instead: one "deep" CSS path with a separator per root, which is
not a selector the browser can run and would need its own parser; and
reusing a full anchor per host, which would run the semantic rules once per
level for little gain, since hosts are usually unique custom elements. The
path is bounded by `WEB_ANNOTATION_MAX_SHADOW_DEPTH` (8), validated in the
protocol and mirrored in the page kit (a test checks they agree); a deeper
target is `unsupported` (`shadow-root`).

### Task 5: resolution extends rule 1 rather than adding a score

As the context asks, the ordered rules were extended. In the page, a `shadow`
scope first resolves each host in its containing root: exactly one element
with the host's tag, found by stable id when that is unique and otherwise by
CSS path, that still has an open shadow root. None, or a host that is closed
or not yet attached, is `missing`; several are `ambiguous`; an empty or
over-long path is `unsupported`. Rules 2 to 5 then run inside the innermost
root only, so a document element with the same id or name is never a
candidate. Ancestors are read in the composed tree, so a host's name and id
corroborate (or contradict) a candidate inside it: a repeated component whose
host moved is told apart by the same ancestor rule as any repeated card. No
new rule name was added; a host failure reports rule `none`.

### Task 5: hit-testing descends through open roots

`document.elementsFromPoint` retargets a hit inside a shadow root to its host,
so Element mode now asks each open root under the point in turn, up to the
depth limit. A hit a root reports outside itself (slotted light content) is
not followed. Keyboard ↑ leaves a root through its host and ↓ enters a host's
open root; the keyboard start uses the focused element inside open roots.
Closed roots expose no `shadowRoot`, so their host is still the target with a
`document` scope, exactly as before. Frames are never entered.

### Task 5: a shadow host is now an ordinary element

Before, selecting a host with an open root gave `unsupported` (`shadow-root`).
Now its content is reachable on its own, so the host is anchored like any
element in its root and gets a live pin. Keeping the old `unsupported` marking
was considered: it would leave whole-component notes without a pin for no
remaining reason. The existing test that asserted the old marking was changed
to say so.

### Task 5: capability gate and fallback for older backends

The backend advertises `operations.shadowTargets` (with authoring) because
its validation accepts the new scope. The renderer
(`withAdvertisedShadowScope` in `capture-commit.ts`) replaces a `shadow`
scope with the older `{ kind: "unsupported", reason: "shadow-root" }` for a
backend that does not advertise it, so the note still saves there and its pin
reports unsupported, as before. Main rebuilds the scope from known fields
(`pickScope` in `browser-preview-capture-parse.ts`), and the brief names the
host tags (never their selectors) so an agent knows which components to look
in.

### Task 5: pins observe the roots they resolve into

A document observer never sees inside a shadow root, so the pin layer also
observes each open root a pass resolved into (at most 64; the kit reports
them through `shadowRootsSeen`). A host that attaches its root only after
pins were shown was a known gap, recorded in
2580 (retired) task 3, with sensitive-field masks inside roots (task 1, which
predates this work), text selections inside roots (task 2) and a live desktop
run (task 4). Tasks 1 and 3 were done on 2026-11-03, task 2 on 2026-11-05 and
task 4 on 2026-11-11 (the desktop's preview view, headless Linux; see
[0044](0044-web-annotation-qualification.md)), and 2580 was retired.

## Current state

- Comparison is side by side only. Capture current result
  (`web_annotation_result_capture`) stores a new immutable after-capture with
  `WebAnnotationComparisonMetadata`: the compared capture, `targetMatch`, and
  labelled route, viewport and target `differences`. `ResultReview.tsx` shows
  the two images. The desktop capture waits for a settle window and reports
  `stable`/`unstable` (`browser-preview-capture.ts`). Pixel diffs and overlays
  are never advertised.
- Development source hints are built (task 4). The desktop anchor script reads
  the documented `data-orkestrator-source` convention
  (`WEB_ANNOTATION_SOURCE_ATTRIBUTES`) on the selected element and its
  ancestors; Electron main rebuilds the hints with `verified: false`
  (`parseSourceHints`); the renderer sends them only when the backend
  advertises `operations.sourceHints`; the backend sets `verified: true` only
  for paths `checkWebAnnotationWorkspacePaths` finds inside the workspace
  (`verifySourceHints` in `web-annotation-service-threads.ts`). Since todo
  0725, a client-declared `verified: true` is refused. See
  [web-page-annotations.md](../../architecture/web-page-annotations.md#development-source-hints).
- Element targets inside open shadow roots anchor to the element itself with
  `scope: { kind: "shadow", hosts }`, the root path outermost first, and
  re-resolve inside the innermost root (task 5, 2026-11-02;
  `browser-preview-anchor-script.ts`). Desktop clients send that scope only
  to a backend advertising `operations.shadowTargets`. iframe and closed-root
  targets still resolve to the host element or `unsupported`, and text
  selections inside shadow roots are refused. Region mode
  (`CaptureModePicker.tsx`) is the fallback for iframe, closed-root and
  canvas content.
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
3. Development source hints: done (task 4). The documented emitter, the thread
   view list and the live captures are done in
   0950.
4. Open shadow roots and same-origin iframes. Open shadow roots are done
   (task 5), and so are its follow-ups (2580, retired 2026-11-11).
   Same-origin iframes remain.
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

- Which extension, if any, is wanted next? Answered on 2026-10-30: source
  hints (task 4), now built; the next pick among tasks 2, 3 and 5 is open.
- Is non-desktop capture worth designing before embedded previews exist? If
  embedded previews are dropped, a backend-owned browser session is the only
  remaining option.

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md).
- [0046-embedded-service-previews.md](0046-embedded-service-previews.md) (web iframe and
  iOS `WKWebView` surfaces).
- [web-page-annotations.md](../../architecture/web-page-annotations.md)
  §"Client capability matrix" and §"Known limitations".
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 7, choosing which product extensions are wanted) moved there on 2026-11-10.
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
