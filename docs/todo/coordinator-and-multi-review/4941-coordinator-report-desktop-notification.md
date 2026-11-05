# Desktop notification when a coordinator wakes with a report

## Task analysis

Analysed 2026-11-05 against main at af2e566e5, with coordinator batch C7 (Work panel and navigation) applied.

### Tasks

1. **Decide whether a report deserves a desktop notification**: C7 built the sound only, as its report recommended. Status: open.

### 1. Decide whether a report deserves a desktop notification

**Problem.** A user who leaves the page hears the "Coordinator report" cue only with the app running and sound on, and the cue does not say which worker reported.

**Context.** From coordinator report C7, part `0450` (Feedback while the coordinator is idle but work runs), task 2, "Notify when a coordinator wakes with a report". The report recommended extending the sound service first and called a notification "a wider feature than this finding". The maintainer put the notification out of scope for C7. C7 added `coordinator-wake-attention` and the cue (`useNotificationSoundService.ts`).

**Investigation.** The original report said desktop notifications already exist for human prompts; they do not. The only ones are for a dialog needing attention (`apps/desktop/electron/dialog-attention.ts`) and a remote restart (`apps/desktop/electron/main.ts`), and `apps/web/src` creates none. The new event is content-free, so it names no worker: a notification with text would need the worker's name from another read, or a wider event.

**Decisions.**

- **What should follow the sound?**
  - **Nothing until use shows the sound is not enough (recommended).**
    - Pros: no new permission handling; works on every client already.
    - Cons: no text, and it needs the app running with sound on.
  - **Build a desktop notification.**
    - Pros: says which worker reported.
    - Cons: new permission handling, nothing on the web client without a separate answer, and a content decision about what may appear on a lock screen.

## Related

- [Mail tiles and the report cue](../../architecture/coordinator.md#mail-tiles-and-the-report-cue)
