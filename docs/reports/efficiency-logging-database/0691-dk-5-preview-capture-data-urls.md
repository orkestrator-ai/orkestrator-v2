# Preview captures cross IPC as large data URLs

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Serve spooled PNGs without a data URL**: stop base64-encoding captures across IPC. Status: open.

### 1. Serve spooled PNGs without a data URL

**Problem.** A capture of up to 8 MiB crosses IPC as about 11 MB of base64, and shrinking it can take up to 12 PNG encodes.

**Context.** Captures are occasional and bounded; the report rates this Low. The spool is owned by Electron main and survives renderer teardown.

**Investigation.** `boundedScreenshotDataUrl` encodes in a loop of up to 12 attempts (`apps/desktop/electron/browser-preview-capture-image.ts:45-69`). The store reads the PNG file and base64-encodes it per read (`apps/desktop/electron/browser-preview-capture-store.ts:736-739`), and the renderer uses the string directly (`apps/web/src/components/browser/annotations/AnnotationCaptureCard.tsx:51`). A privileged custom scheme already exists for artifacts (`apps/desktop/electron/main.ts:246`, `apps/desktop/electron/artifact-host-session.ts:564`).

**Decisions.**

- **Worth a new protocol?**
  - **Leave it until a capture is shown to stall the UI (recommended).**
    - Pros: no new privileged surface for an occasional, bounded cost.
    - Cons: main and the renderer keep paying for the base64 per capture.
  - **Serve spooled PNGs through a privileged custom protocol, as the report suggests.**
    - Pros: no base64, and no clone of a large string.
    - Cons: a new scheme has to check the window's right to that capture, and redaction reads the pixels through the existing string.

## Constraints and rationale

Captures can hold page content, so any scheme must apply the spool's own per-window ownership. Do not weaken that for speed.

## Needs verification

- Real capture sizes and stall time. Nothing was measured, and the report's confidence is Medium.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 12

## Outcome

Checked item by item on 2026-11-05 against base commit `69a3b4ca5`.

| Item in this file | Outcome | Code and test, evidence, or to-do |
| --- | --- | --- |
| Task 1: Serve spooled PNGs without a data URL, full images | Done | Done on 2026-11-04 (1202 task 12): `BrowserPreviewPendingCaptureWire.imageBytes`, `readWire`. Tests: `preload-api.test.ts` ("capture images across IPC"), `browser-preview-capture-store.test.ts`. |
| Task 1: same, region crops | Done | `BrowserPreviewRegionCropWire`, `cropPng`, `readPendingWire`, `regionCropWithDataUrl`. Tests: `browser-preview-capture-flow.test.ts` ("a region crop across IPC"), `browser-preview-capture-image.test.ts` ("region crop encoding"), `preload-api.test.ts`; `web-annotations-electron.spec.ts` in a real window. |
| Investigation: `boundedScreenshotDataUrl` base64 in main | Done | Replaced by `boundedScreenshotPng` with `toPNG`; `store.readWire` for recapture. Test: `browser-preview-capture-image.test.ts`. Real Electron: `toPNG` matched `toDataURL` bytes on five sources. |
| Investigation: the store base64-encodes per read (`browser-preview-capture-store.ts:736-739`) | No longer holds | `readWire` returns the file's bytes. `read` and `pendingCaptureWithDataUrl` remain, with no production caller after this change. |
| Investigation: the renderer uses the string directly (`AnnotationCaptureCard.tsx:51`) | Kept on purpose | The preload makes the data URL, now with `Uint8Array.toBase64` (`pngBytesToDataUrl`); the median renderer gap stayed at 5 to 10 ms. Test: `preload-api.test.ts` ("every base64 padding length"). |
| Problem: "up to 12 PNG encodes" | No longer holds as a cost | Real encoder: 1 encode, or 2 for a 2000x2000 noise bitmap. The time per encode on main moved to to-do 5540, task 1. |
| Decision: worth a new protocol? Leave it until a capture is shown to stall the UI (recommended) | Done | Taken. Measured first: the stall found was the preload's JS base64 (197 ms on read, 367 ms sending a redaction, at 7.64 MiB), fixed with native base64 to 9 ms and 5.5 ms. Numbers in 1202 task 12. No scheme added. |
| Decision: serve through a privileged custom protocol | Not taken | The trigger above is not met. The rejected option is recorded in `docs/architecture/web-page-annotations.md`. |
| Constraints: a scheme must apply the spool's per-window ownership | No longer holds as written | The spool is per process (`browserPreviewCaptureStore` in `main.ts`) and read by capture id; the boundary is the trusted-renderer IPC check. Crops use the same handler, so nothing widened. Test: `main-ipc.test.ts` (an untrusted sender is refused `capture-pending-read`). Recorded in to-do 5540. |
| Needs verification: real capture sizes and stall time | Done in part; rest moved to to-do 5540 | Measured in real Electron 45 up to 7.64 MiB, numbers in 1202 task 12. Real users' pages, other platforms and slower hardware are to-do 5540, task 2. |
