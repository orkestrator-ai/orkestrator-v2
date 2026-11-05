# Shadow-root annotation follow-ups

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`. First analysed 2026-11-02
against `main` at `38d55ee1`, while building element targets inside open
shadow roots ([0047](0047-web-annotation-extensions.md) task 5) on branch
`shadow-root-annotations-583af4c65646-r1`. Tasks 1 and 3 were done on
2026-11-03 on branch `shadow-root-field-ab26ddbffb9a-r1`, and task 2 on
2026-11-05 on branch `shadow-root-text-30ed9d8e6bed-r1`.

### Tasks

1. **Sensitive-field masks inside open shadow roots**: password, card and
   one-time-code fields inside a shadow root are not masked in screenshots.
   Status: done.
2. **Text selections inside open shadow roots**: Text mode refused a
   selection inside a shadow root. Status: done.
3. **Pins on hosts that attach their root late**: a pin whose host gains its
   shadow root after pins were shown waits for an unrelated DOM change.
   Status: done.
4. **Live desktop qualification**: an element note inside a shadow root
   captured and re-shown in the real desktop app. Status: open.

### 1. Sensitive-field masks inside open shadow roots

**Problem.** `sensitiveRects` in
`apps/desktop/electron/browser-preview-anchor-script.ts` finds sensitive
fields with `document.querySelectorAll(SENSITIVE_SELECTOR)`, which does not
search inside shadow roots. A password input rendered by a web component is
therefore not masked in a capture's screenshot. This predates shadow-root
targets: it applies to every capture of such a page, whatever the target.

**Context.** The masks are applied in the page and again in the pixels before
the image is spooled (see "Capture" in
[web-page-annotations.md](../../architecture/web-page-annotations.md)). The
kit already bounds every walk by visits and time.

**Investigation.** Nothing in the kit enumerates open shadow roots. Element
and text evidence already skip a sensitive element's value and, since the
shadow-root work, `insideSensitive` follows the composed tree, so the gap is
the screenshot mask only. Rechecked on 2026-11-03 at `7b48c23f`: still true,
and the old scan also stopped silently after 128 candidates or 32 visible
fields, leaving any further field unmasked. Done: `sensitiveScan` (see
Assumptions and decisions).

**Decisions.**

- **How to find fields inside roots?**
  - **A bounded walk that queries each open root it meets (recommended).**
    Walk the document with a visit and time budget, and for each element with
    an open `shadowRoot` run the same selector there, down to
    `MAX_SHADOW_DEPTH`. If the budget runs out, drop the image
    (`imageExcluded`), as for unmaskable fields today.
    - Pros: covers component libraries; the fail-closed path already exists.
    - Cons: a full walk on every capture; large pages may hit the budget and
      lose their image.
  - **Only the roots on the selected target's path.**
    - Pros: cheap.
    - Cons: misses fields in every other component on screen, which is where
      most of them are.

### 2. Text selections inside open shadow roots

**Problem.** `describeRange` returned `unsupported` when the selection's
container was not in the document, so a quote inside a component could not be
annotated in Text mode.

**Context.** `window.getSelection()` retargets ranges in shadow trees, and
`Selection.getComposedRanges()` is the standard way to read them. The text
resolver (`resolveText`) built one text map for the document only.

**Investigation.** The element work added a `shadow` scope for anchors; a text
range's `container` anchor could carry the same scope, and the text map could
be built for the innermost root. Rechecked on 2026-11-05 at `41f9eb638`: still
true. The pinned Electron 45.0.0 is Chromium 156.0.8078.48, where
`getComposedRanges` exists and takes `{ shadowRoots }`, in the main world and in
an isolated world alike. Probing real drags showed three more things:
`getRangeAt` on a selection inside a root returns a collapsed range around the
host, which is why Text mode never saw it; on a selection from light text into
a root it returns a non-collapsed range cut at the host, so such a selection
used to save a shortened quote rather than be refused; and a selection whose
top level is the root has a `ShadowRoot` or a text node under it as the common
ancestor, with no containing element. Done (see Assumptions and decisions).

**Decisions.**

- **Support it, and how?**
  - **Use `getComposedRanges` with the open roots on the path, and resolve in
    the innermost root's text map (recommended).**
    - Pros: reuses the element root path; no change to the stored quote shape.
    - Cons: needs Chromium support checks in the pinned Electron; a quote
      spanning the light/shadow boundary stays unsupported.
  - **Leave it to Element and Region.**
    - Pros: nothing to build.
    - Cons: quotes inside components stay unannotatable.

### 3. Pins on hosts that attach their root late

**Problem.** The pin layer observes the document and each open shadow root a
pass resolved into. A host that exists but attaches its shadow root later (a
custom element defined after pins were shown) resolves `missing`, and no
observer sees the attach, so the pin appears only after another DOM change or
when the panel re-sends pins.

**Context.** `attachShadow` and content written into a new root fire no
mutation on the document. Re-sending happens after every navigation, so a
reload is not affected; the gap is a lazily defined component on a page that
is already showing pins.

**Investigation.** `customElements.whenDefined(tag)` resolves when a host's
definition arrives, which is the usual cause. Rechecked on 2026-11-03 at
`7b48c23f`: still true. A headless Chromium check on 2026-11-03 found that
`window.customElements` is `null` in an isolated world (where the desktop
runs the pin layer), while `element.matches(":defined")` and `shadowRoot`
work there. Done, with a fallback for that case (see Assumptions and
decisions).

**Decisions.**

- **How to notice the attach?**
  - **Schedule one pass when `customElements.whenDefined` resolves for each
    missing host tag (recommended).**
    - Pros: event-driven; bounded by the number of pins.
    - Cons: does not cover a defined element that attaches its root later on
      its own.
  - **A slow periodic pass while any shadow pin is `missing`.**
    - Pros: covers every case.
    - Cons: steady work on pages that will never match.

### 4. Live desktop qualification

**Problem.** The shadow-root work was checked in happy-dom and in headless
Chromium through Playwright, not in the desktop app's preview view.

**Context.** The Chromium check drove a real pointer click on open,
nested-open and closed roots and re-resolved both open-root targets after a
reload. The desktop runs the same scripts in an isolated world, which can
differ for `shadowRoot` access.

**Investigation.** Not run: it needs a `dev:test` profile and a fixture page
with a web component. On 2026-11-05, for task 2, the capture and pin scripts did
run through `executeJavaScriptInIsolatedWorld` in the pinned Electron with
input from `sendInputEvent` (see Verification). That was a plain window on the
headless Ozone platform, not the preview view, with no capture or main-side
parse, so it answers the isolated-world question only.

**Decisions.**

- **Where to qualify?**
  - **Add a web-component page to the annotation fixture and run it through
    0044's desktop checklist (recommended).**
    - Pros: covers the isolated world and the main-side parse.
    - Cons: a manual desktop run on a frontmost host.
  - **Rely on the headless Chromium check.**
    - Pros: already done.
    - Cons: does not exercise the isolated world or the native view.

## Assumptions and decisions

### Task 1: one bounded walk, failing closed

Took the recommended option. `sensitiveScan` in
`browser-preview-anchor-script.ts` replaces `sensitiveRects`: it queries the
document, then walks its elements in tree order and queries each open
`shadowRoot` it meets, recursively, down to `MAX_SHADOW_DEPTH` (8) roots. One
budget of 100,000 visits or 100 ms covers the walk and every candidate. It
returns `{ rects, complete }`, and both probes (the capture runtime's and the
responsive set's) send `sensitiveComplete`.

`complete` is false, and Electron main drops the image, when the budget runs
out, roots nest deeper than the limit, a query throws, or more than 32
visible fields are on screen. The last case was a silent truncation before;
it now fails closed too, because a 33rd field would otherwise be spooled
unmasked. Main reads only `sensitiveComplete === true` as complete, so a
probe without the field also keeps no pixels. A single capture keeps its text
evidence with `imageExcluded: true`; a responsive-set width fails as
`unsupported`, the code it already used for unmaskable pixels.

Options considered for the budget: 60,000 visits / 120 ms like a pin pass, or
100,000 / 100 ms. Chose the latter: the walk touches each element once and
does no text work, so visits are cheap, and a page over 100,000 elements is
rare. A page that exceeds it loses its screenshot, which is the documented
trade-off.

Closed shadow roots remain unmasked: page script cannot reach them, and no
option in this task changes that. The architecture page lists it as a known
limitation.

### Task 3: one pass per defined tag, with an isolated-world fallback

Took the recommended option, and added a fallback it needed. When a pass
finds a host that matches its saved path but has no shadow root and is not
`:defined` (a custom element name only; built-in hosts are never waited on),
the kit reports it through `undefinedHostsSeen()`. The pin layer then:

- calls `customElements.whenDefined(tag)` once per tag and schedules one
  ordinary (throttled, paused-aware) pass when it resolves;
- where `customElements` is unavailable, which is the case in the desktop's
  isolated world, checks those host elements' `:defined` state every 500 ms,
  at most 120 times per layer (`definitionCheckMs`, `definitionChecks`), and
  schedules one pass when one turns defined. This reads at most 50 elements
  per check; it is not a resolution pass, so it does not reopen the rejected
  "slow periodic pass" option.

Options considered for the isolated world: inject a main-world helper that
forwards `whenDefined` (rejected: a second script in the page's own world, and
CSP can block it), poll with full passes (rejected in the analysis), or the
bounded element check (chosen). A replaced host that is still undefined is
watched again; a definition that arrives after the 60-second allowance waits
for the next DOM change or re-send, as before.

A host that is already defined and attaches its root later on its own is still
not noticed, as the analysis accepted.

### Task 2: `getComposedRanges`, one tree per quote

Took the recommended option; the stored quote shape did not change. The kit's
`selectionRange` reads the selection and `describeRange` describes it; a quote
resolves in the text map of its container's innermost root (`textMapOf`, one
per root in a pass, reached through the same `resolveRoot` as an element).

**How to find the open roots on the path.** `getComposedRanges` reveals only
the roots it is given.

- **Start from the boundary (chosen).** An endpoint in an unlisted root reads as
  the position around its host, so list the root of each host at a boundary and
  read again, one level per pass, at most `MAX_SHADOW_DEPTH` + 1 passes.
  - Pros: touches only the selection's own path, no walk; a host next to an
    endpoint that does not contain it is harmless, since listing its root moves
    nothing.
  - Cons: more calls than a list known in advance, though at most nine.
- **Pass every open root on the page**, as `sensitiveScan` finds them.
  - Pros: one call.
  - Cons: a full walk on every mouse-up in Text mode, with a budget that could
    fail on a large page.

**A selection crossing a boundary.** Endpoints in two trees are `unsupported`,
as the analysis accepted: a `Range` and a text map each cover one tree. That
now includes light into a root, which used to save a shortened quote, plus a
root out to light, into its own nested root, and into a sibling root.

**Closed roots.** Unreachable by design. A document selection whose
`getRangeAt` differs from its composed range has an endpoint in a tree the kit
cannot read, so it is `unsupported`, with the hint. No closed text is read.
Select all is exempt: Chromium composes it as the root element's contents and
keeps a narrower live range, so it was the one disagreement on a page with no
shadow root at all.

- **Refuse on the difference (chosen).**
  - Pros: covers inside a closed root and light into one with one rule; the
    user sees why, where a selection inside a closed root used to do nothing and
    one from light into it used to save a shortened quote.
  - Cons: any other source of disagreement would refuse a document selection,
    with the hint rather than silently. Chromium agreed on about 30 others: drags
    across paragraphs, lists, tables, `<details>` and contenteditable, and over
    light inputs, buttons, selects and video; double and triple clicks; `addRange`
    and a backward `setBaseAndExtent`. Selecting inside a focused light input also
    disagrees, but Text mode returns on the focused field before reading it.
- **Accept the light side.**
  - Pros: no risk to document selections.
  - Cons: keeps a shortened quote that does not say what the user selected.

**A range at the top level of a root** has no containing element: text directly
under the root, or a range across its top-level elements.

- **The host's semantics, scoped to the root, no stable id, path `:host`
  (chosen).**
  - Pros: works for a text-only root; the brief names the component; `:host`
    matches nothing in a root query, so it cannot address a wrong element.
  - Cons: `semantic` describes the host, not an element in the root; the
    protocol comment on `shadow` scope says so.
- **The first element in the range.**
  - Pros: an ordinary anchor.
  - Cons: there is none for a text-only root, and it would claim the quote is
    inside an element it only starts in.

**Quote context** runs to the top of the root (`rangeContextRoot`) rather than
stopping at the top-level element, so a repeated quote is told apart by its
neighbours as it is in the document. Element anchors keep their context as it
was, so saved ones are not affected.

**Sensitive fields** keep the same rules, with three additions the root needed:
`insideSensitive` now climbs from text directly under a root (`elementOf`; the
parent is not an element there, so a sensitive host was missed), Text mode reads
the focused element through open roots, and a quote whose host is sensitive
resolves `missing`, since its text is in no document map either.

**Older backends.** `withAdvertisedShadowScope` now also rewrites a text range's
container to `unsupported` (`shadow-root`), so a backend without
`operations.shadowTargets` still saves the note and its pin reports unsupported.

**Real Chromium test.** Committed as a slow-tier `.integration` test, not run
only by hand as in tasks 1 and 3, because happy-dom has neither the API nor
selection gestures. It skips where no Chromium is installed.

### Verification

Task 2: `apps/desktop/tests/browser-preview-shadow-text.test.ts` (happy-dom,
with a standard-following stand-in for `getComposedRanges`) and
`browser-preview-shadow-text.integration.test.ts` (Playwright's Chromium 156,
scripts in a CDP isolated world, real pointer input and a real reload), plus
`capture-commit.test.ts` and `web-annotation-shadow-targets.test.ts`. On
2026-11-05 the same scripts ran in the pinned Electron 45.0.0 through
`executeJavaScriptInIsolatedWorld`, with `sendInputEvent` drags, on the headless
Ozone platform: quotes in an open and a nested root were `selected` and
`matched` by `text-quote` after a reload, light into a root and inside a closed
root were refused with the hint, and a document selection still captured. The
desktop's preview view was not run (task 4).

Tasks 1 and 3: unit tests in `apps/desktop/tests/browser-preview-shadow-follow-ups.test.ts`
(happy-dom) and main-side tests in `browser-preview-manager-capture.test.ts`
and `browser-preview-show-on-page.test.ts` cover both tasks; all fail without
the change. happy-dom never matches `:defined`, so its isolated-world test
stubs that state. A headless Chromium run on 2026-11-03, with the scripts in a
CDP isolated world, listed a password field inside an open root
(`complete: true`) and resolved a pin from `missing` to `matched` about 0.8 s
after the host was defined, with no mutation batch. The desktop app itself was
not run (task 4).

## Related

- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) task 5.
- [web-page-annotations.md](../../architecture/web-page-annotations.md)
  §"Anchors and pins" and §"Known limitations".
