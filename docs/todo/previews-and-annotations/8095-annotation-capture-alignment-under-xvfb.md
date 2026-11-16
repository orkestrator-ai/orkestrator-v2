# Annotation capture alignment fails in an X11 window under Xvfb

## Task analysis

Analysed 2026-11-16 against `main` at `a0920f1a7`. Found while closing 0044
(retired 2026-11-16) task 9, from the weekly Electron CI job's artifacts.

### Tasks

1. **Find what the extra highlight-coloured rows are**: read the capture
   image the failing case now attaches. Status: open (waits on the next
   `electron-qualification.yml` run that includes the attachment change).
2. **Fix the cause in the product or the test**: Status: open (depends on 1).

### 1. Find what the extra highlight-coloured rows are

**Problem.** `capture pixels stay on the target at preview zoom 0.8, 1 and
1.5 and at DPR 1 and 2` (`e2e/agent-testing/web-annotations-electron.spec.ts`)
fails in every run of `.github/workflows/electron-qualification.yml`, which
runs the Electron suite in real X11 windows on Xvfb. The weekly job stays red
because of it, and a real alignment regression in that case would go
unnoticed.

**Context.** Six runs failed identically: 43734503500 (2026-11-15, the job's
first), 43764416395, 43769696970, 43805692906, 43840642859 and the scheduled
run on `main` at `da2561021` (43869578513, 2026-11-16); in a seventh,
43784353265, the case was skipped after an earlier failure. The error each
time:
`natural-direct-dpr-1-zoom-1 highlight: {"box":{"x":200,"y":137,"width":160,"height":93},"expected":{"x":200,"y":140,"width":160,"height":90}}`,
against a tolerance of 2. The zoom 0.8 capture before it passed. Pixels
within 40 of the highlight's border colour (`#2684ff`) appear in three rows
above the target, inside its column (the box's x and width are exact). The
same case passes headless: on beelink on 2026-11-16 at `a0920f1a7` the same
capture measured `{"x":200,"y":140,"width":160,"height":90}` (runs
`q0044-electron-1116` and `q0044-electron-1116-align`), as on 2026-11-06 and
2026-11-11. The case used to attach the capture only after its checks
passed, so no CI run kept the image; since 2026-11-16 it attaches the capture
whenever the highlight or marker check fails.

**Investigation.** Three rows matches the spread of the highlight's outer
ring (`boxShadow: "0 0 0 1px rgba(255,255,255,0.75), 0 0 0 3px rgba(38,132,255,0.22)"`
in `apps/desktop/electron/browser-preview-annotation-script.ts`), but that
ring would widen the box on the left and right as well, and over the
fixture's light page it blends to a colour outside the tolerance. The hover
tooltip is placed 34 px above the target (`rect.y - 34`), so its bottom edge
sits about 137 px down, but its border blends to a dark blue that is also
outside the tolerance; the tooltip is hidden before the screenshot, so it
would show only in a stale frame. Flake
[9806](../../tests/flaky-tests/previews-annotations-and-gateway/9806-annotation-capture-stale-frame-after-dpr2-relaunch.md)
caught exactly that headless under load: a capture whose pixels predated its
geometry, possibly because the prepare step's paint wait gives up after
150 ms. Neither is established. Agent hosts may not run an
X11 display (beelink's rules forbid Xvfb), so the image from CI is the next
step.

**Decisions.**

- **How to get the image?**
  - **Wait for the next scheduled weekly run after this change merges
    (recommended).**
    - Pros: no outward action; the artifact keeps the attachment for 14 days.
    - Cons: up to a week's wait.
  - **Dispatch `electron-qualification.yml` by hand.**
    - Pros: the image the same day.
    - Cons: an outward action on the repository that needs the user's
      approval; a 20-minute runner job for one image.

### 2. Fix the cause in the product or the test

**Problem.** As task 1.

**Context.** The capture must show the page as the user saw it, with only
the inspector's own highlight added on purpose.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **Where to fix?**
  - **Follow the image: fix the product when an inspector overlay or other
    element the capture should not contain is captured, and narrow the
    test's colour match only when the rows are page content the user also
    sees (recommended).**
    - Pros: keeps the case a real alignment check.
    - Cons: needs task 1 first.
  - **Raise the tolerance to 3 device pixels.**
    - Pros: green at once.
    - Cons: hides a real 3 px shift, which is exactly what the case guards.

## Needs verification

- After the fix, a green run of the case in `electron-qualification.yml`
  (X11 on Xvfb) and headless on Linux.

## Related

- [web-page-annotations.md](../../architecture/web-page-annotations.md#client-capability-matrix):
  the capability matrix row for the native window names this gap.
- [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  task 8: the scheduled Electron job.
