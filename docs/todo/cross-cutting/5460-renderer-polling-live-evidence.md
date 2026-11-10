# Renderer polling: live evidence left from efficiency report 0620

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

What was left of `docs/reports/efficiency-logging-database/0620-e23-renderer-polling.md` (batch E23) once its code was done. That report is deleted; read it with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0620-e23-renderer-polling.md`, or at the parent of its deletion commit, where it ends with its outcome table. The code of all three parts landed in #1754 (`bfac1f577`); its numbers and decisions are in to-do 1202 task 3 (retired 2026-11-10) under "WEB-12, WEB-13, WEB-14, WEB-16, WEB-18 and WEB-19". Each task below is one of the report's "Needs verification" items that only a live install can settle.

### Tasks

3. **Hidden-window pauses in a real Electron window**: part `0660` (WEB-18), its Needs verification item, on Linux and macOS. Status: open (the spec can be written now; running it needs the disposable display host in 7568: 6303 task 2).

### 3. Hidden-window pauses in a real Electron window

**Problem.** The report asked how much hidden-window timer throttling already hid these polls. The polls now issue no reads at all while the document is hidden, so throttling no longer matters to the browser; what is left is whether a real Electron window reports itself hidden when it is minimised, hidden or covered, which is what makes the pause happen there.

**Context.** `startCoordinatedPoll` (`apps/web/src/lib/coordinated-poll.ts`) hands every poll the report names to the read coordinator, which pauses on `document.visibilityState === "hidden"` (`apps/web/src/lib/read-coordinator.ts`) and reads once on return when the interval has passed. The desktop app leaves Electron's `backgroundThrottling` at its default. A window that stays `visible` while covered would keep polling at full rate, as before.

**Investigation.** Proven here: `coordinated-poll.test.ts` (`stops while the window is hidden and reads once on its return`; 200 reads by a 3 s poll in 10 min hidden became 0), the hidden-window tests in `useUserCommands.test.tsx` and `useAnnotationCapture.test.tsx`, and 1202 task 3's Chromium run (8 commands in 12 s visible, 0 hidden). Not run: a real Electron window, minimised, hidden and fully covered on macOS and Linux (Windows is in the manual-test checklist, 7568: 5460 task 3). 1202 lists the same gap for `local-gateway-transport-electron.spec.ts`, which needs a disposable display.

**Decisions.**

- **How to check it?**
  - **Run the Electron agent suite on a disposable display with a spec that minimises, hides and covers the window and counts renderer commands (recommended).**
    - Pros: the real main process and window; repeatable.
    - Cons: needs a host with a disposable display, and covering a window is platform-specific.
  - **Check by hand in a packaged build with the gateway's request metrics.**
    - Pros: no new spec.
    - Cons: not repeatable.
- **If a covered window stays `visible`?**
  - **Also pause on the window's blur and occlusion events relayed from the main process (recommended).**
    - Pros: covers what the page cannot see itself.
    - Cons: a new desktop-to-renderer signal with its own compatibility row.
  - **Accept it.**
    - Pros: no change; minimised and hidden windows still pause.
    - Cons: a covered window keeps polling.

## Constraints and rationale

- The read coordinator is read-only and must never own commands; upload retries in `useAnnotationCapture` stay on their own timer for that reason.
- Report invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`): only the view's reads pause, never the work they watch, and a missed event stays detectable through the list resync.
- Use an isolated `dev:test` profile for anything run locally; never point a check at a production instance.

## Related

- to-do 1202 efficiency follow-ups, task 3 (retired 2026-11-10)
- [Version compatibility](../../architecture/version-compatibility.md#register): rows for the single-environment read and the conditional folder reads
- Efficiency report, D (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 2, the Windows part of task 3) moved there on 2026-11-10.
