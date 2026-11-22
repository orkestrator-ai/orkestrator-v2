# Desktop killed during a system shutdown

## Task analysis

Analysed 2026-11-22 against `main` at `af78acfbf`. From the self-improvement ticket for `logging:writer-died:desktop` (one occurrence on omarchy-hp, 2026-11-15T21:13:03Z), whose build fixed the two causes inside the app (an AppImage update releasing the single-instance lock before `essential.stopped`, and "Close application" calling `app.exit`).

### Tasks

1. **Confirm whether a logout or reboot on Omarchy kills the desktop before `essential.stopped`**: reproduce, then fix if it does. Status: open.

### 1. Confirm whether a logout or reboot on Omarchy kills the desktop before `essential.stopped`

**Problem.** If the system stops the app before its quit finishes, the next start reports `logging:writer-died:desktop`, a crash-category signal, for what was an ordinary shutdown.

**Context.** Omarchy sets `DefaultTimeoutStopSec=5s`, and `systemctl show user@1000.service -p TimeoutStopUSec` reads `5s` on beelink2, so the whole user session has 5 s to stop before SIGKILL. The desktop's quit holds `will-quit` for up to `BACKEND_EXIT_WAIT_MS` (20 s) while the backend drains, and writes `essential.stopped` only after that (`registerWillQuitHold` in `apps/desktop/electron/main.ts`). Electron turns the first SIGTERM into `app.quit()`; a second one, or the SIGKILL, ends the process at once. The omarchy-hp essential log was not readable from the build, so whether the 2026-11-15 occurrence was a reboot is not known.

**Investigation.** Not reproduced. A reproduction on a Linux host: start a packaged build in a scope with a short stop timeout (`systemd-run --user --scope -p TimeoutStopSec=5s …`) against a throwaway data directory, give the backend a slow drain (a running local environment), stop the scope, then check the essential log for a desktop `essential.started` with no `essential.stopped`. The previous boot's journal (`journalctl -b -1`) on omarchy-hp would show a stop timeout for the app if that is what happened.

**Decisions.**

- **How to make a shutdown-time quit end with `essential.stopped`.**
  - **Shorten the quit when it was started by a termination signal (recommended).** Install SIGTERM and SIGHUP handlers in the desktop main process that record the signal, call `app.quit()` and cap the backend wait at about 3 s.
    - Pros: the marker is written inside the system's budget, and the backend still gets its SIGTERM from the same stop.
    - Cons: a backend drain cut short may leave its own environment cleanup to the next start; Electron's own signal handling has to be checked against Node's handlers.
  - **Write `essential.stopped` before waiting for the backend.**
    - Pros: one line, no signal handling.
    - Cons: the backend's drain lines (`shutdown.finished`) reach the essential log through the desktop and would be lost on every quit.
  - **Record the quit's start as an essential event and let self-improvement report a death after it separately.**
    - Pros: tells an interrupted quit from a crash without changing the quit.
    - Cons: changes the log vocabulary and the signal's meaning; it does not make the quit finish.

## Related

- [Debugging crashes, killed processes and blank windows](../../debugging/process-crashes-and-kills.md#8-loggingwriter-dieddesktop-with-no-crash)
- [Application logging](../../architecture/logging.md)
