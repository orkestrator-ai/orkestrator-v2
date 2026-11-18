# Non-desktop annotation capture

## Task analysis

Analysed 2026-11-18 against main at `b2c91abb9`.

Moved here from 0047 (retired) task 6, its one task still waiting, when 0047's
last open task (advisory result diffs) was built on 2026-11-18. The analysis
below is 0047's, rechecked on that date.

### Tasks

1. **Non-desktop capture**: let the web client and iOS capture annotations,
   not only review them. Status: blocked (waits on 7568: 0042 task 3, per the
   embedding deferral recorded by
   [0046](0046-embedded-service-previews.md) task 1 on 2026-10-30; the
   embedded host remains unimplemented).

### 1. Non-desktop capture

**Problem.** Web and iOS can list, reply, request and review annotations, and
read advisory result diffs of desktop captures, but cannot capture.

**Context.** Needs a design choice between a trusted preview bridge and a
backend-owned browser session; must never import cookies implicitly. Shares
surfaces with 0046. Every other annotation extension arrived behind its own
capability flag (`operations.sourceHints`, `shadowTargets`, `frameTargets`,
`resultDiffs` in `WebAnnotationCapabilities`); this one should too.

**Investigation.** Capture is gated by `canCapture`
(`apps/web/src/components/browser/annotations/AnnotationPanel.tsx`), which
needs the desktop capture API. On 2026-10-30, 0046 task 1 decided to defer
embedding until top-level Safari and iOS pass in
[0042](0042-service-preview-rollout.md) task 3, which remains blocked on
macOS Safari and iOS hardware. 0046's embedded surfaces remain unimplemented,
so no embedded host for a bridge exists. Rechecked 2026-11-18: still true.

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

## Current state

- Only Electron captures. Web and iOS list, reply, request and review, and
  hide capture (`canCapture` in `AnnotationPanel.tsx`). The architecture
  doc's
  [client capability matrix](../../architecture/web-page-annotations.md#client-capability-matrix)
  records this.
- 0046's embedded web and iOS previews are not built.

## Outstanding work

- Start with a short design decision that compares a trusted preview bridge
  with a backend-owned browser session. The chosen method must either keep
  the real page state or clearly disclose that it is a separate session. It
  must never import the user's cookies or credentials implicitly.
- It shares its surfaces with
  [0046-embedded-service-previews.md](0046-embedded-service-previews.md). An
  embedded web or iOS preview is the likeliest host for a bridge, and its
  `postMessage` and sandbox rules apply. Never inject privileged scripts into
  arbitrary application pages.
- Until then, web and iOS keep capture unavailable, as they do today. Record
  that in the capability matrix as a deferral, not as parity.
- Qualify it like the other extensions: synthetic pages with deterministic
  changes, animation, late fonts, mismatched viewports, an expired login and
  failed functional checks.

## Constraints and rationale

- No inspection of arbitrary third-party sites; no automatic commits, PRs or
  approvals; no code generation from private framework internals.
- Fresh captures are new immutable assets, and redactions apply to every
  image, as on the desktop.

## Open questions

- Is non-desktop capture worth designing before embedded previews exist? If
  embedded previews are dropped, a backend-owned browser session is the only
  remaining option.

## Related

- [0046-embedded-service-previews.md](0046-embedded-service-previews.md) (web
  iframe and iOS `WKWebView` surfaces).
- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) task 3
  (top-level Safari and iOS runs, in the manual-test checklist).
- [web-page-annotations.md](../../architecture/web-page-annotations.md):
  every other annotation extension, as built.

## Replaces

- 0047 (retired) task 6 (`git show b2c91abb9:docs/todo/previews-and-annotations/0047-web-annotation-extensions.md`).
