# Desktop killed during a system shutdown

## Task analysis

Analysed 2026-11-22 against `main` at `af78acfbf`. From the self-improvement ticket for `logging:writer-died:desktop` (one occurrence on omarchy-hp, 2026-11-15T21:13:03Z), whose build fixed the two causes inside the app (an AppImage update releasing the single-instance lock before `essential.stopped`, and "Close application" calling `app.exit`).

Updated 2026-11-28 against `main` at `a8e5ea708`: task 1 was built without a reproduction (option A of its decision), and the confirmation of the 2026-11-15 occurrence became task 2.

### Tasks

1. **Make a quit started by a logout, reboot or shutdown write `essential.stopped` inside the session's stop timeout.** Status: done (2026-11-28).
2. **Confirm whether the 2026-11-15 omarchy-hp occurrence was a system stop**, from the previous boot's journal and the real essential log after the next reboot. Status: open (depends on 7568: the user's approval, at the next omarchy-hp reboot, for a read-only look at the real log directory).

### 1. Make a quit started by a logout, reboot or shutdown write `essential.stopped` inside the session's stop timeout

**Problem.** If the system stops the app before its quit finishes, the next start reports `logging:writer-died:desktop`, a crash-category signal, for what was an ordinary shutdown.

**Context.** Omarchy sets `DefaultTimeoutStopSec=5s`, and `systemctl show user@1000.service -p TimeoutStopUSec` reads `5s` on beelink2, so the whole user session has 5 s to stop before SIGKILL. The desktop's quit held `will-quit` for up to `BACKEND_EXIT_WAIT_MS` (20 s) while the backend drained, and wrote `essential.stopped` only after that (`registerEssentialShutdown` in `apps/desktop/electron/essential-logging.ts`). Electron turned the first SIGTERM into `app.quit()`; a second one, or the SIGKILL, ended the process at once.

**Investigation.** Not reproduced before the fix. A reproduction on a Linux host: start a packaged build in a scope with a short stop timeout (`systemd-run --user --scope -p TimeoutStopSec=5s …`) against a throwaway data directory, give the backend a slow drain (a running local environment), stop the scope, then check the essential log for `quit.signal-received` followed by `essential.stopped` (fixed) or a desktop `essential.started` with no `essential.stopped` (not fixed). Built on 2026-11-28:

- `apps/desktop/electron/quit-signals.ts`: `installQuitSignalHandlers` listens for SIGTERM and SIGHUP. The first one logs the essential event `desktop quit.signal-received` (`signal`, `backendWaitMs`), caps the backend wait at `SIGNAL_QUIT_BACKEND_WAIT_MS` (3 s) from that moment and calls `app.quit()`. A later signal logs `quit.signal-repeated` and is otherwise ignored, so it neither starts a second quit nor kills the process mid-quit.
- `apps/desktop/electron/backend-lifecycle.ts`: `createBackendQuitWait` measures the backend wait from `before-quit` and accepts a cap that only shortens it, also while an ordinary quit is already waiting. `registerBackendShutdown`'s `stopped()` now rejects when the wait runs out, so all three holds that wait on the drain (the backend hold, the application log flush and the essential stop marker) are released by the same deadline, and the essential hold then writes `essential.stopped`. An ordinary quit keeps the 20 s bound; the holds' own timeouts remain the backstop.
- `apps/desktop/electron/main.ts` creates one wait, hands it to `registerBackendShutdown` and installs the handlers.
- Tests: `apps/desktop/tests/quit-signals.test.ts` (the cap, the unchanged user-quit bound, a signal during a user quit, a second signal, and `quit.signal-received` then `essential.stopped` in a real essential log for each signal); the vocabulary and essential-log tests list the new event.

**Decisions.**

- **How to make a shutdown-time quit end with `essential.stopped`.**
  - **Shorten the quit when it was started by a termination signal (recommended, built).** Install SIGTERM and SIGHUP handlers in the desktop main process that record the signal, call `app.quit()` and cap the backend wait at about 3 s.
    - Pros: the marker is written inside the system's budget, and the backend still gets its SIGTERM from the same stop.
    - Cons: a backend drain cut short may leave its own environment cleanup to the next start; Node's listener replaces Electron's own signal handling.
  - **Write `essential.stopped` before waiting for the backend.**
    - Pros: one line, no signal handling.
    - Cons: the backend's drain lines (`shutdown.finished`) reach the essential log through the desktop and would be lost on every quit.
  - **Record the quit's start as an essential event and let self-improvement report a death after it separately.**
    - Pros: tells an interrupted quit from a crash without changing the quit.
    - Cons: changes the log vocabulary and the signal's meaning; it does not make the quit finish.

### 2. Confirm whether the 2026-11-15 omarchy-hp occurrence was a system stop

**Problem.** Task 1 fixed the likely cause without evidence that it was the cause of the one recorded occurrence. If the 2026-11-15 death was something else, `logging:writer-died:desktop` will come back on omarchy-hp and the cause is still unknown.

**Context.** The omarchy-hp essential log was not readable from the build: it lives in the real app's data directory (`~/.config/orkestrator-v2/logs/essential/`), which agents do not read without the user's approval. The journal of the boot that ended on 2026-11-15 has probably rotated out by now, so the evidence has to come from the next reboot or logout. The checklist item is in [7568](../manual-test/7568-manual-test-checklist.md) under Cross-cutting.

**Investigation.** Not started. At the next omarchy-hp reboot or logout with Orkestrator running, and with the user's approval for a read-only look: `journalctl --user -b -1` and `journalctl -b -1` for a stop timeout or SIGKILL of the app or `user@1000.service`, then the tail of `essential.jsonl`. On a build with task 1, a system stop shows `quit.signal-received signal=SIGTERM` (or `SIGHUP`) followed by `essential.stopped`; a desktop `essential.started` with no `essential.stopped` after a reboot would mean the 3 s cap is still not enough, or that the stop was not a signal at all.

**Decisions.**

- **Where the evidence comes from.**
  - **Read the previous boot's journal and the essential log after the next reboot, with the user's approval (recommended).**
    - Pros: shows directly whether a system stop timed out and whether the fixed quit now writes its marker; read-only and changes nothing.
    - Cons: waits on a reboot and on the user.
  - **Reproduce in a `systemd-run` scope with `TimeoutStopSec=5s` on a fleet host against a throwaway data directory.**
    - Pros: an agent can do it alone.
    - Cons: proves the fix works, not what happened on 2026-11-15.

## Assumptions and decisions

### Task 1: a 3 s cap measured from the signal

Chose 3 s, counted from the signal rather than from the start of the quit, so a signal during a user quit that has already waited longer ends the wait at once. That leaves about 2 s of Omarchy's 5 s for closing the application log and writing `essential.stopped`, which take milliseconds on a working disk. The cap is a constant (`SIGNAL_QUIT_BACKEND_WAIT_MS`), not a setting.

### Task 1: a second signal is ignored

Electron's own handling killed the process on a second signal. A logout can deliver SIGHUP and SIGTERM together, so that would lose the marker exactly when it is needed; the quit is already bounded by the cap, so ignoring the repeat cannot hang it. The repeat is still logged (`quit.signal-repeated`, not essential).

### Task 1: the first signal always calls `app.quit()`

Even when an ordinary quit has started, the first signal calls `app.quit()` again. Electron ignores it while quitting, and every `before-quit` listener is idempotent; it restarts a quit that a window cancelled.

### Task 1: a new essential event rather than reusing `backend shutdown.signal-received`

The desktop's quit start is recorded as `desktop quit.signal-received` with `signal` and `backendWaitMs`, listed in the logging guide's essential table. The backend's event belongs to the backend area and describes the backend's own shutdown.

### Task 2: who can act

The look at the real log directory needs the user's approval, so the task waits on a checklist item in 7568 rather than on an agent.

## Related

- [Debugging crashes, killed processes and blank windows](../../debugging/process-crashes-and-kills.md#8-loggingwriter-dieddesktop-with-no-crash)
- [Application logging](../../architecture/logging.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md) (8315 task 2)
