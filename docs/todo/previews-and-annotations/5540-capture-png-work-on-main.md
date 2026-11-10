# Capture PNG work on Electron main

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried over from efficiency report `0691` (DK-5, retired on 2026-11-05; git history keeps it): task 1's problem statement ("shrinking it can take up to 12 PNG encodes") and its Needs verification section.

### Tasks

1. **PNG work blocks main**: a capture encodes its PNG on main, and a region read decodes, crops and encodes there. Status: open.
2. **Sizes and stalls beyond one machine**: the stall numbers come from one Mac and synthetic pages. Status: open.

### 1. PNG work blocks main

**Problem.** `toPNG` is synchronous on Electron main, which serves every window. A capture blocks it for about 68 ms on a 2x UI page and 342 ms on a noisy 3.88 MiB page. Each read of a region capture blocks it for 22 to 64 ms, because `readPendingWire` crops from the spooled PNG on every read.

**Context.** Report `0691` rated captures Low because they are occasional and bounded. A capture runs after a user action, once per capture. The cost is not base64 and not IPC, so neither the byte wire nor a custom scheme changes it.

**Investigation.** Measured in real Electron 45 on macOS arm64; the table is in to-do 1202 task 12 (retired 2026-11-10). The report's "up to 12 encodes" did not appear: an incompressible 2000x2000 bitmap settled in two real encodes. `boundedScreenshotPng` is in `apps/desktop/electron/browser-preview-capture-image.ts`, and the crop is in `readPendingWire` in `browser-preview-capture.ts`. The renderer reads a capture through `useAnnotationCapture.ts`; how many reads a region capture gets per save was not counted.

**Decisions.**

- **Move the PNG work off main?**
  - **Leave it until a user reports a freeze during capture, or a real page is shown above about 100 ms on typical hardware (recommended).**
    - Pros: no new process or encoder for an occasional cost after a user action.
    - Cons: a noisy page holds up every window's IPC for about a third of a second per capture.
  - **Encode in a separate process.**
    - Pros: main stays free whatever the page.
    - Cons: the masked bitmap, which holds page content, crosses to another process; masks must still be painted before anything is encoded; `toPNG` would need replacing there, and whether `nativeImage` runs in a utility process was not checked.
- **Crop on every read?**
  - **Keep cropping on read (recommended).**
    - Pros: a crop always follows the current, possibly redacted, image; there is nothing to invalidate.
    - Cons: 22 to 64 ms on main per read.
  - **Store the crop in the spool.**
    - Pros: a read costs one file read.
    - Cons: a second file holding page content, which redaction, expiry and the spool's byte limit must all cover; an unredacted crop left behind would be a privacy failure.

### 2. Sizes and stalls beyond one machine

**Problem.** Report `0691` asked for real capture sizes and stall time. They were measured on one Mac with synthetic pages, so nothing here is from a real user's pages, from Linux or Windows, or from slower hardware.

**Context.** The size limit bounds the worst case: the renderer stayed near its idle floor at 7.64 MiB of the 8 MiB limit, so a real page can be only slightly larger than what was tested. Only the time per byte can differ between machines.

**Investigation.** `getCaptureDiagnostics` reports spool depth and bytes, not per-capture sizes or encode time. The harness was a throwaway in the git-ignored `output/` folder and was not committed; 1202 task 12 describes its load.

**Decisions.**

- **Collect more?**
  - **Re-measure only if task 1 is taken up or a stall is reported (recommended).**
    - Pros: the renderer gap has margin even if a slower machine takes several times as long.
    - Cons: main's encode time on slow hardware stays unknown.
  - **Add content-free encode-time and size counters to `getCaptureDiagnostics`.**
    - Pros: real numbers from real pages.
    - Cons: more diagnostics surface to maintain for a Low-rated cost.

## Constraints and rationale

Captures hold page content. One spool serves every window of the process and has no per-window ownership: the IPC handler admits any trusted renderer by capture id (`browser-preview-capture-store.ts`, `main.ts`). Any new path to a capture's bytes must check at least what that handler checks, and masks must be in the pixels before the first encode.

## Related

- to-do 1202 efficiency follow-ups, task 12 (retired 2026-11-10)
- Efficiency report, G (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [Web page annotations](../../architecture/web-page-annotations.md#pending-spool-and-acknowledged-transfer)
