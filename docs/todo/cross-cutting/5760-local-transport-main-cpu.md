# Local windows: the direct transport does not lower Electron main's CPU

## Task analysis

Analysed 2026-11-05 against `main` at `e1f4c875f`.

### Tasks

1. **Find where main's time goes on the direct transport**: explain why Electron main spends more CPU with a local window on the direct gateway transport than on the relay. Status: open.
2. **Decide what the default flip rests on**: whether [4501](4501-local-window-transport-default.md) task 2 waits for task 1. Status: open (depends on 1).

### 1. Find where main's time goes on the direct transport

**Problem.** The direct transport was built to take terminal output and commands off Electron main. Measured, it does not lower main's CPU at all, and with two windows or a burst it raises it.

**Context.** From efficiency report part `0400` (E26), task 1 "Capture the baseline" and its "Needs verification: real main-process cost". The transport is `global.localWindowGatewayTransport`, off by default ([1202](1202-efficiency-review-follow-ups.md) task 12). Its event and command counts were in 1202 task 12; main's CPU was not measured until 2026-11-05, when `e2e/agent-testing/local-gateway-transport-electron.spec.ts` was extended to sample it.

**Investigation.** Measured 2026-11-05 on macOS (Darwin 27, Apple Silicon), Electron 45, through that spec: its own disposable agent-test profile, the Vite dev renderer, one local terminal, no provider turn. Main is `process.cpuUsage()` in Electron main; renderer is the summed `cumulativeCPUUsage` of every `Tab` process. Three runs per mode; ranges below. Each CPU window starts after the command is typed, because main (Chromium's browser process) handles every synthetic key, and the spec polls the page every 50 ms to see the end, which costs main about 40–48 ms per 5 s on both transports (the "polled idle" row).

| Window | Relay (setting off), main | Direct (setting on), main | Relay, renderer | Direct, renderer |
| --- | --- | --- | --- | --- |
| Idle, 5 s | 7.2–7.6 ms | 7.0–9.2 ms | 166–188 ms | 183–202 ms |
| Polled idle, 5 s | 40.0–48.3 ms | 45.8–47.1 ms | 167–194 ms | 188–285 ms |
| One window, 300 lines over 4.9–5.3 s (about 380 terminal events; main read about 65 KB on the relay) | 262–342 ms | 289–330 ms | 1,510–1,682 ms | 1,525–1,742 ms |
| One window, 200,000 lines (1.29 MB) in 0.43–0.61 s, 76–88 frames | 42–61 ms | 64–72 ms | 183–302 ms | 230–295 ms |
| Two windows on the same terminal, the same 300 lines | 252–311 ms | 335–368 ms | 2,397–2,842 ms | 2,707–2,937 ms |
| Two windows, the same burst | 39–67 ms | 113–131 ms | 278–399 ms | 482–532 ms |

On the relay, main sent 920–938 events to the two windows during the two two-window loads; on the direct transport it sent none. So the relay's own work (JSON parse plus a structured clone per window per event) is small next to what main does anyway at this load, and something on the direct path costs main more than it saves.

Not established, only candidates read from code:
- A local window on the direct transport has its requests rewritten by `installRemoteGatewayRequestAuth` (`apps/desktop/electron/remote-gateway-request-auth.ts:120`), which installs `onBeforeSendHeaders` and `onHeadersReceived` listeners. With `webRequest` listeners installed, Electron routes the session's loads through its proxying loader in the browser process, and each command and each stream reconnect runs those JavaScript callbacks in main.
- Each direct window holds its own event streams (one main stream and one per terminal), so main brokers several long-lived network loads per window where the relay had one.

The measurement used the dev renderer over `http://`; a packaged `file://` window is not qualified yet (4501 task 1).

**Decisions.**

- **How to find the cost?**
  - **Profile main with the spec's two-window burst, once per transport (recommended).** Record a CPU profile of Electron main (`--inspect` and the V8 profiler, or `contentTracing` for the browser process's native side) during the burst, and compare where the time goes.
    - Pros: names the cost instead of guessing; the spec already produces a repeatable load.
    - Cons: native browser-process time may not show in a JavaScript profile, so it may need a trace too.
  - **Switch off the header hooks for local windows and re-measure.** Give local windows their credential another way (for example a per-window token the preload hands the page) and see if main's CPU falls.
    - Pros: tests the likeliest candidate directly.
    - Cons: a credential change made before the cause is known; the page holding a token is what the current design avoids.

### 2. Decide what the default flip rests on

**Problem.** [4501](4501-local-window-transport-default.md) task 2 flips the default to the direct transport after one release. The CPU figures do not support that flip on main-process cost.

**Context.** The flip was decided on 2026-11-01 (1202 task 12) on the report's reasoned impact. The relay's other costs are real but were not measured here: the JSON parse and clones run on main's JavaScript thread, where they can delay IPC handling even when total CPU is low.

**Investigation.** Not started. It waits for task 1.

**Decisions.**

- **What should the flip wait for?**
  - **Task 1's answer, and a fix if the cause is cheap to remove (recommended).**
    - Pros: the default does not move to a path that costs main more; the setting stays as the fallback either way.
    - Cons: the relay's per-event work on main's JavaScript thread stays the default for longer.
  - **Flip on schedule, on the grounds of main-thread latency rather than CPU.**
    - Pros: fewer serialisations per invoke and nothing on main's JavaScript thread per terminal event.
    - Cons: no measurement shows that latency matters, and main's total CPU rises with two windows.
  - **Drop the flip and keep the relay as the default.**
    - Pros: keeps the cheaper path for main at this load.
    - Cons: keeps two transports indefinitely, or throws away the direct one.

## Related

- [4501 local window transport default](4501-local-window-transport-default.md).
- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 12.
- [Closing check of E26](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e26-local-desktop-transport), which records the outcome of report part `0400`.
- [Remote gateway](../../architecture/remote-gateway.md).
