# Local windows: make the filtered gateway transport the default

## Task analysis

Analysed 2026-11-06 against `main` at `585cf97d8`; rechecked 2026-11-11 against `main` at `498b68766`.

### Tasks

1. **Qualify a packaged window**: run the new transport on a packaged `file://` renderer. Status: done (2026-11-11).
2. **Flip the default**: after one release behind the setting. Status: done (2026-11-11).
3. **Retire the relay for local windows**: remove the second path once the default has held. Status: open (depends on 2 having shipped in a release and held through the next one with no open report against the direct transport).

### 1. Qualify a packaged window

**Problem.** The transport had only run on the dev renderer, over `http://`.

**Context.** To-do 1202 task 12 (retired 2026-11-10) shipped it behind `global.localWindowGatewayTransport`, off by default. `local-gateway-transport-electron.spec.ts` drives a real window, but through Vite.

**Investigation.** A `<meta>` Content Security Policy only reaches a production build (`renderer-security.md`). From code: `connect-src` allows `http:`, and main rewrites `Origin` on the two routes, so a `file://` page should behave the same.

Done 2026-11-11 on mini (macOS, Apple Silicon, Electron 45): `packaged-security-electron.spec.ts` gained two tests, `packaged file:// window: the direct gateway transport by default` and `… an explicit false keeps main's relay`. Each launches the unsigned shipping `--dir` build (`release/mac-arm64`, fuses verified by `scripts/verify-packaged-security.ts`) on a disposable profile with its windows hidden, attaches over CDP, and from the `file://` page runs `get_config` and `patch_global_config` through `window.orkestrator`, then waits for the `resource-changed` event that mutation announces. On the direct transport the page holds `orkestratorDesktopHost` (`api`, `baseUrl`), both commands appear as resource timings to the backend's loopback control origin, the event arrives on the page's own stream, and main's relay delivers no copy to the preload's listener; Settings → Experimental shows the switch on. With `false` stored the page has no host and makes no HTTP command at all. Both passed (21.3 s for the pair), and again on a re-run against the same build later that day (16.4 s for the pair, `--grep "packaged file:// window"`). The first run found only harness faults: the window talks to the control listener rather than the gateway port, and the "GitHub CLI Not Found" startup dialog hid Settings until it was dismissed (`dismissStartupDialogsOnPage`).

**Decisions.**

- **How to qualify?**
  - **Extend `packaged-security-electron.spec.ts` to turn the setting on, run a command and receive an event (recommended).**
    - Pros: it already asserts the policy on the packaged renderer.
    - Cons: needs a shipping build.
  - **By hand on a packaged build.**
    - Pros: no harness change.
    - Cons: not repeatable.

### 2. Flip the default

**Problem.** Local windows paid the relay's cost unless a user opted in.

**Context.** Decided 2026-11-01: the default moves after one release behind the setting. Moving the terminal to the WebSocket is a separate decision.

**Investigation.** The flip waits for the release and task 1. The setting was a boolean read as `=== true`, so a flip must not turn a user's explicit `false` into on.

Both conditions held on 2026-11-11: the setting shipped in 2.36.2-beta (#1741, after 2.36.1) and has been in every release since, through 2.37.5-beta, and task 1 passed. Done the same day: `readLocalWindowGatewayTransport` now answers on unless `config.json` says `false` (a missing setting, file or unparseable file is on), Settings shows unset as on and stores an explicit `false` when turned off, and the description says it is on by default. Specs that measure or exercise main's relay now pin it with an explicit `false` (`relayed-events-electron.spec.ts`, the relay run of `local-gateway-transport-stack.ts`).

Main's CPU no longer argues against the flip. On 2026-11-05 `local-gateway-transport-electron.spec.ts` measured the direct transport costing Electron main more than the relay with two windows (113–131 ms against 39–67 ms for the 1.29 MB burst). The cause is the measuring harness, not the transport. To-do 5760 profiled that burst on 2026-11-06 (macOS, Apple Silicon, Electron 45, the Vite dev renderer), and its findings are recorded here because 5760 was closed:

- **Main's JavaScript is nearly idle on the direct transport.** A V8 profile of main during the burst shows no time in the `webRequest` header hooks (`remote-gateway-request-auth.ts`). They run once per request, and a stream's chunks do not pass through them. Across a whole two-window load they took about 1 ms.
- **The extra time is DevTools forwarding.** A Chromium trace puts it on two browser-process threads. `CrBrowserMain` handled 551 `blink.mojom.DevToolsSessionHost` messages (33 ms, against 171 messages and 1.5 ms on the relay), and `Chrome_DevToolsHandlerThread` spent 34.6 ms (0.8 ms on the relay). Playwright holds a DevTools session on every page with its network domain on, and a development window opens a detached DevTools window as well. So every load and stream chunk a direct page receives becomes a DevTools event that main forwards. Relay output arrives over IPC and makes none. With the development DevTools windows closed, Playwright's session alone still accounted for 56 ms of the direct burst's 116 ms (38.1 ms on the handler thread, 18.2 ms on `CrBrowserMain`).
- **With no DevTools client, the direct transport costs main less on every load.** `local-gateway-transport-cpu-electron.spec.ts` starts Electron with only main's Node inspector and closes the development DevTools windows. These original figures used custom page listeners without mounted terminal views; they isolate transport delivery and are not the visible-terminal workload. Three alternating runs per transport, CPU in ms. The host was running other worktrees' browser suites (load average 46–64 when checked just after), so each `sleep 0.01` took longer than in the 2026-11-05 runs, and the 300-line loads lasted 14–24 s instead of about 5 s:

  | Window | Relay, main | Direct, main | Relay, renderers | Direct, renderers |
  | --- | --- | --- | --- | --- |
  | Idle, 5 s | 7.8–12.5 | 5.8–8.7 | 5.9–48.4 | 4.3–4.5 |
  | One window, 300 lines (14–24 s on this host) | 138–202 | 80–84 | 108–230 | 199–242 |
  | One window, 200,000 lines (1.29 MB) | 51–57 | 4.0–5.2 | 15–21 | 28–31 |
  | Two windows, 300 lines | 143–188 | 43–52 | 121–239 | 147–160 |
  | Two windows, the same burst | 46–54 | 4.1–7.3 | 81–85 | 137–178 |

  The relay sent 190–240 terminal events to the two windows during that burst, and the direct transport none. The renderers spend more on the direct transport because each page parses its own stream. That is the work moving off main, which every window, menu and IPC call shares, and onto each window's own process.
- **The Playwright spec on current `main` still shows the old pattern, but noisily.** Three runs of it unchanged at `585cf97d8`, on a host with a load average of 46–64, gave a two-window burst of 161–837 ms direct against 107–311 ms on the relay, and a one-window burst of 152–205 ms against 108–155 ms. The 300-line loads stretched to 13–55 s, so those ranges are wide. One run of the branch version, which closes the development DevTools windows before measuring (load average about 17), gave 78 ms direct against 67 ms on the relay for the two-window burst. Playwright's own session is what remains of the gap.

Review repair qualification on 2026-11-06 added mounted xterm views in both
windows and verified every load marker in each buffer, while keeping page
DevTools detached. One alternating run per transport passed, with zero desyncs
in every measured window. Main CPU in ms (relay / direct): idle 6.8 / 4.8,
one-window 300 lines 111.5 / 9.0, one-window burst 29.0 / 1.7,
two-window 300 lines 103.8 / 52.5, two-window burst 22.3 / 6.3.
This is a single qualification run, not a replacement for the three-run ranges
above. Output identifies the workload as `mounted-terminals`.

What has not been measured is a packaged `file://` window (task 1) and any platform other than macOS.

**Decisions.**

- **How is the default stored?**
  - **Keep the boolean and treat a missing value as on, so an explicit `false` stays off (recommended).**
    - Pros: no migration; a user who turned it off stays off.
    - Cons: the setting's meaning depends on the release that wrote it.
  - **Migrate stored configs.**
    - Pros: the file states the value.
    - Cons: a migration for one boolean.
- **What does the flip rest on?** (decided 2026-11-06, from to-do 5760)
  - **Task 1 and one release behind the setting, as decided on 2026-11-01; main's CPU is no longer a condition (recommended).**
    - Pros: with no DevTools client, main's CPU on the direct transport is lower on every load measured, so the flip takes the relay's per-event work off the process every window shares; the setting stays as the fallback.
    - Cons: the renderers do the parsing instead and spend more (two-window burst 137–178 ms against 81–85 ms); measured on the macOS dev renderer only.
  - **Also re-measure on a packaged `file://` window before the flip.**
    - Pros: covers the renderer users run, not Vite's.
    - Cons: needs the CPU spec ported to the packaged harness. The transport code is the same for both origins, so the result is not expected to differ, though that is reasoned rather than measured.
  - **Keep the relay as the default.**
    - Pros: one fewer change.
    - Cons: keeps the path that costs main more.

### 3. Retire the relay for local windows

**Problem.** Two transports have to keep working while the switch exists.

**Context.** The rollback exists so that a user with a broken window can fall back without a new build. Remote windows still use main's relay and are not part of this.

**Investigation.** Not started, and not startable yet: by its own decision below it waits until the flip has shipped in a release and held through the next one with no open report against the direct transport. As of 2026-11-11 the flip is on this branch only. Removal would touch `relayBackendEvent`, `setTerminalOutputRelay` and the host split in the preload. Main's own event consumers (`hostUpdates`, `liveLogPolicy`) still need its stream. Specs that pin the relay with an explicit `false` (task 2) go with it.

**Decisions.**

- **When?**
  - **At least one release after the flip, with no open report against the new transport (recommended).**
    - Pros: keeps the fallback while the new default is new.
    - Cons: two paths for longer.
  - **In the same release as the flip.**
    - Pros: less to maintain sooner.
    - Cons: no way back without a build.

## Assumptions and decisions

Decisions made on 2026-11-06 while closing to-do 5760, which asked where Electron main's extra time went on the direct transport and what task 2 rests on.

1. **How the cost was found (5760 task 1).** Options: profile main during the two-window burst, or switch off the `webRequest` header hooks for local windows and re-measure. Chose profiling: a V8 CPU profile of main through its inspector and a Chromium trace (`contentTracing`), read with Perfetto's `trace_processor`. Pros: it named the cost (DevTools forwarding) instead of testing a guess, and it showed the header hooks cost about 1 ms. Cons: Electron 45 writes traces only as Perfetto protobuf, so reading one needs a tool from outside the repository.
2. **No change to how a local window authenticates (5760 task 1).** Options: keep main's `webRequest` hooks adding the credential below the page, or give the page a per-window token and drop the hooks. Kept the hooks. They took no measurable time while output streamed, so removing them would have given the page a credential it does not hold today and gained nothing. Nothing in this change touches credential handling.
3. **Fix the measurement, not the transport (5760 task 1).** Options: leave `local-gateway-transport-electron.spec.ts` as the main-CPU baseline, or add a measurement with no DevTools client. Added `local-gateway-transport-cpu-electron.spec.ts`, opt-in through `ORKESTRATOR_LOCAL_TRANSPORT_CPU=1`. The existing spec now also closes the development DevTools windows before it measures, and its header says why its main figures overstate the direct transport. Pros: the figures reflect a shipped window, and the drive is the same terminal load. Cons: one more spec to keep running, and Playwright's own session cannot be detached in the existing one, so its figures stay a regression check only.
4. **What task 2 rests on (5760 task 2).** Chose task 1 and one release behind the setting, as recorded in task 2's Decisions. The higher renderer CPU is the intended trade: it is the parsing that main no longer does, spread over each window's own process.

### Benchmark reliability and workload (task 2, review repair)

Chose a resource observer over the bounded resource entry count: it observes later
completions after the 250-entry buffer fills; merely increasing the buffer
would retain a saturation threshold. Chose mounted terminal views with rendered
marker checks over listener-only delivery for qualification: this includes the
UI workload but costs more renderer CPU and setup time. Stream readiness,
per-measurement desync recovery, validated run counts and unconditional cleanup
make invalid or interrupted measurements fail explicitly. Seven focused regressions, a real-browser overflow check (301 completions
with a 250-entry buffer), and enabled one-run-per-transport qualification
passed.

### Qualifying the packaged window (task 1, 2026-11-11)

Chose to extend `packaged-security-electron.spec.ts`, as the task recommended, rather than a hand check: it already launches the shipping binary under the packaged policy, and the new tests run in the same `mise run test:package:security`. Each transport gets its own launch, so the existing security test is left as it was. The window is hidden through `ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS` so the run takes no focus. The event used is `resource-changed` from a config patch that re-states a value: it needs no fixture repository or environment, and it is a backend event main would relay to a relay window, so its absence on the preload's listener shows the direct window got it from its own stream. Terminal output over the filtered stream is not part of the packaged check; it uses the same client code as the dev renderer, where `local-gateway-transport-electron.spec.ts` covers it.

### How the default is stored (task 2, 2026-11-11)

Implemented the recommended option: the boolean stays, unset is on, and only an explicit `false` keeps the relay. No config migration. An unreadable or unparseable `config.json` also counts as on, because it is the default; before the flip it fell back to off for the same reason. The setting stays under Settings → Experimental as the rollback until task 3.

### When to flip (task 2, 2026-11-11)

Flipped in this change rather than waiting for another release: the 2026-11-01 condition (one release behind the setting) had been met many times over, and task 1 was the other condition. Not re-measured on the packaged window (the option "also re-measure on a packaged `file://` window" was not recommended in task 2's Decisions).

## Needs verification

- The packaged transport tests ran on macOS only. Linux runs the same tests through `mise run test:package:security` on a Linux host (for example `omarchy-hp`); not run for this change.
- The existing `shipping binary has the L3 fuses …` test in the same spec now runs on the direct transport by default and was not re-run here, because it opens a visible window on macOS. Run the whole `mise run test:package:security` before the release.

## Related

- to-do 1202 efficiency follow-ups, task 12 (retired 2026-11-10).
- [Measuring Electron main's CPU](../../development/agent-testing.md#measuring-electron-mains-cpu), the method behind the figures in task 2.
- Closing check of E26 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), the outcome of efficiency report parts `0400` and `0860`.
- [Remote gateway](../../architecture/remote-gateway.md).
