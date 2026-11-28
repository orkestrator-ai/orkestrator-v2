# Desktop killed during a system shutdown

## Task analysis

Analysed 2026-11-22 against `main` at `af78acfbf`. From the self-improvement ticket for `logging:writer-died:desktop` (one occurrence on omarchy-hp, 2026-11-15T21:13:03Z), whose build fixed the two causes inside the app (an AppImage update releasing the single-instance lock before `essential.stopped`, and "Close application" calling `app.exit`).

Updated 2026-11-28 against `main` at `a8e5ea708`: task 1 was built without a reproduction (option A of its decision), and the confirmation of the 2026-11-15 occurrence became task 2.

### Tasks

1. **Make a quit started by a logout, reboot or shutdown write `essential.stopped` inside the session's stop timeout.** Status: done (2026-11-28).
2. **Confirm whether the 2026-11-15 omarchy-hp occurrence was a system stop**, from the incident's journal and the matching desktop run in the essential log. Status: open (depends on 7568: the user's approval, at the next omarchy-hp reboot or logout, for a read-only look at the real log directory).

### 1. Make a quit started by a logout, reboot or shutdown write `essential.stopped` inside the session's stop timeout

**Problem.** If the system stops the app before its quit finishes, the next start reports `logging:writer-died:desktop`, a crash-category signal, for what was an ordinary shutdown.

**Context.** Omarchy sets `DefaultTimeoutStopSec=5s`, and `systemctl show user@1000.service -p TimeoutStopUSec` reads `5s` on beelink2, so the whole user session has 5 s to stop before SIGKILL. The desktop's quit held `will-quit` for up to `BACKEND_EXIT_WAIT_MS` (20 s) while the backend drained, and wrote `essential.stopped` only after that (`registerEssentialShutdown` in `apps/desktop/electron/essential-logging.ts`). Electron turned the first SIGTERM into `app.quit()`; a second one, or the SIGKILL, ended the process at once.

**Investigation.** To reproduce the system stop on Linux, start a packaged build with a throwaway data directory under a user service with `TimeoutStopSec=5s`. Give the backend a slow drain, stop that service, and check the affected desktop run for `quit.signal-received` followed by `essential.stopped`. The shutdown uses these paths.

- `quit-signals.ts` reattaches the SIGTERM and SIGHUP listeners at Electron readiness, after the native shutdown handlers are installed. It bypasses renderer unload vetoes only during signal shutdown and leaves repeated signals on the original deadlines. The essential signal event records `signal`, the remaining `backendWaitMs`, and `quitAlreadyRequested`.
- `desktop-shutdown.ts` shares the signal deadlines across the backend, essential marker and application log flush. The essential writer can start before the window closes. If Electron still has not exited after 4.75 s, the signal handler calls `app.exit(0)`.
- An ordinary quit retains the actual backend-close result. The backend hold can release at 20 s while the essential hold can still confirm a later close for AppImage relaunch.
- The supervised backend acquires its own data-directory lock before startup and holds it through exit. A replacement desktop can open after a signal quit while its backend waits for the previous owner.
- The focused tests cover an ordinary late close, a wall-clock change, repeated signals, and stalled log writers. The Electron fixture passed on macOS and Linux ARM64 with real SIGTERM and SIGHUP delivery, an unload veto, a blocked application log flush and an old backend still draining. It used the development Electron executable. The packaged systemd stop remains a separate check.

**Decisions.**

- **How to make a shutdown-time quit end with `essential.stopped`.**
  - **Shorten the quit when it was started by a termination signal (recommended, built).** Install SIGTERM and SIGHUP handlers in the desktop main process that record the signal, call `app.quit()` and cap the backend wait at about 3 s.
    - Pros: leaves time for the marker and lets the backend continue draining with exclusive ownership.
    - Cons: a stalled writer may miss the marker, and a replacement backend can wait for its predecessor.
  - **Write `essential.stopped` before waiting for the backend.**
    - Pros: one line, no signal handling.
    - Cons: the backend's drain lines (`shutdown.finished`) reach the essential log through the desktop and would be lost on every quit.
  - **Record the quit's start as an essential event and let self-improvement report a death after it separately.**
    - Pros: tells an interrupted quit from a crash without changing the quit.
    - Cons: changes the log vocabulary and the signal's meaning; it does not make the quit finish.

### 2. Confirm whether the 2026-11-15 omarchy-hp occurrence was a system stop

**Problem.** Task 1 fixed the likely cause without evidence that it was the cause of the one recorded occurrence. If the 2026-11-15 death was something else, `logging:writer-died:desktop` will come back on omarchy-hp and the cause is still unknown.

**Context.** The essential log is in the real app's data directory and requires the user's approval to read. The historical journal or the relevant log entries may have rotated. The checklist item is in [7568](../manual-test/7568-manual-test-checklist.md) under Cross-cutting.

**Investigation.** Search both the user and system journals for the historical incident, using `--utc --since '2026-11-15 21:03:03 UTC' --until '2026-11-15 21:23:03 UTC'` or the exact boot ID from `journalctl --list-boots`. Look for the Orkestrator app unit or `user@1000.service` stopping, timing out or receiving SIGKILL. In `essential*.jsonl`, match the desktop run active at the stop by timestamp. Its records run from its desktop `essential.started` up to the next desktop `essential.started`, even if that crosses rotated files. Record the historical result as inconclusive if the relevant records are missing or cannot be correlated.

For a new logout or reboot on a build with task 1, record its own UTC time and query that time window or its exact boot ID. A logout can occur in the same boot as the next launch. In the desktop run active at the stop, check for `quit.signal-received` followed by `essential.stopped` before the next launch's records. Record this separately as a check of the fix.

**Decisions.**

- **Use the journal window or exact boot ID and correlate the desktop run (recommended).**
  - Pros: remains valid after multiple reboots and for a same-boot logout.
  - Cons: depends on retention and approval to read the essential log.
- **Reproduce a five-second system stop on a throwaway profile.**
  - Pros: exercises the current build under the target timeout.
  - Cons: provides evidence about the current build only.

## Assumptions and decisions

### Task 1: signal deadlines and the backend owner

The backend wait ends at the earlier of the ordinary 20 s allowance from `before-quit` and 3 s after the signal. A signal 5 s into an ordinary quit therefore caps the backend wait at 8 s from the start of that quit. The 4.5 s log deadline is measured from the signal using the monotonic clock. The essential marker can finish while the application log flush is pending. The backend holds its own lock to keep the old drain and a replacement startup from using the data directory at once.

### Task 1: signals and window cancellation

The first signal calls `app.quit()` and allows renderer unload to proceed during that shutdown. Later signals are logged and ignored. `quitAlreadyRequested` records an earlier `before-quit` event, including when the window had vetoed that request.

### Task 2: log access and incident selection

The real essential log still needs the user's approval. The historical incident and the next system stop are recorded separately.

## Related

- [Debugging crashes, killed processes and blank windows](../../debugging/process-crashes-and-kills.md#8-loggingwriter-dieddesktop-with-no-crash)
- [Application logging](../../architecture/logging.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md) (8315 task 2)
