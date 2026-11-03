# Shadow-root annotation follow-ups

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23f`. First analysed 2026-11-02
against `main` at `38d55ee1`, while building element targets inside open
shadow roots ([0047](0047-web-annotation-extensions.md) task 5) on branch
`shadow-root-annotations-583af4c65646-r1`. Tasks 1 and 3 were done on
2026-11-03 on branch `shadow-root-field-ab26ddbffb9a-r1`.

### Tasks

1. **Sensitive-field masks inside open shadow roots**: password, card and
   one-time-code fields inside a shadow root are not masked in screenshots.
   Status: done.
2. **Text selections inside open shadow roots**: Text mode refuses a
   selection inside a shadow root. Status: open.
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

**Problem.** `describeRange` returns `unsupported` when the selection's
container is not in the document, so a quote inside a component cannot be
annotated in Text mode.

**Context.** `window.getSelection()` retargets ranges in shadow trees, and
`Selection.getComposedRanges()` is the standard way to read them. The text
resolver (`resolveText`) builds one text map for the document only.

**Investigation.** The element work added a `shadow` scope for anchors; a text
range's `container` anchor could carry the same scope, and the text map could
be built for the innermost root.

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
with a web component.

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

### Verification

Unit tests in `apps/desktop/tests/browser-preview-shadow-follow-ups.test.ts`
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
