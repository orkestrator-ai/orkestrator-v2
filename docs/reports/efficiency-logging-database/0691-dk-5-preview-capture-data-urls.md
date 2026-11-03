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
