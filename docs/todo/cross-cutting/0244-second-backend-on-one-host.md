# A second backend on the same host takes the live one's Control MCP port

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Keep a second backend off the default Control MCP port**: only the default install binds 34122; other data directories take another port and publish it. Status: partly done (agent-test backends use an ephemeral port since #1301; a production-flavour service for a second data directory still binds 34122).
2. **Recover the port when it frees up**: retry a failed Control MCP bind and show the conflict in Settings. Status: open.
3. **Detect a second instance**: at startup, notice another live backend for this user and avoid its per-user resources. Status: open.
4. **Find why the live backend exited at 00:58:57**: reproduce in a VM or container and identify the mechanism. Status: partly done (it was a SIGKILL from an unknown sender; the eight-hour freeze and the 09:11 SIGBUS are explained).
5. **Qualify two backends on one host**: in a VM or container, neither loses its Control MCP or exits when the other boots, restarts or stops. Status: open (depends on 1 to 3).

### 1. Keep a second backend off the default Control MCP port

**Problem.** Any backend binds `127.0.0.1:34122` if it is free when it starts, so a service for a second data directory can take the port the user's external MCP clients are configured for, and the desktop app comes up with no Control MCP.

**Context.** Found during [0033](0033-remote-host-upgrades.md)'s standalone service qualification. The CLI supports a second data directory with its own unit (`serviceUnitSuffix`, `packages/cli/src/client/service-units.ts:20`). Constraint: the default install must keep 34122.

**Investigation.** `DEFAULT_CONTROL_MCP_PORT` is at `apps/backend/src/core/control-mcp-server.ts:40`; `configuredControlMcpPort` (`:82`) still defaults every backend to it. New since the file was written: `controlMcpPortOverride` (`:103`-`:110`, added by `0a2ea7e3`, #1301, 2026-10-26) gives port 0 to every `--runtime-flavor agent-test` backend and to `NODE_ENV=test`, unless `ORKESTRATOR_CONTROL_MCP_PORT` is set; `docs/architecture/control-mcp.md` says so. That covers the services in the incident (they ran as `agent-test`, but from npm 2.30.0-beta, before the fix), and `scripts/qualify-standalone-service.ts:430` now also sets `ORKESTRATOR_CONTROL_MCP_DISABLED=1`. Still open: a production-flavour `orkestrator service install --data-dir <other>` writes only `PATH` and `NODE_ENV` (`service-units.ts:106`-`:107`) and binds 34122. The descriptor still names no Control MCP endpoint: `BackendInstanceEndpoint.role` is the gateway's `control` or `client` listener (`packages/protocol/src/backend-instance.ts:23`-`:24`), and the Control MCP URL appears only in the stdout ready line (`apps/backend/src/main.ts:326`). `defaultDataDir` (`apps/backend/src/data-dir.ts:19`) exists, so "is this the default data directory" is cheap to answer.

**Decisions.**

- **Which backend may bind 34122?**
  - **Only a backend whose data directory resolves to `defaultDataDir()`; any other defaults to an ephemeral port unless `ORKESTRATOR_CONTROL_MCP_PORT` is set (recommended).**
    - Pros: fixes every second-instance path (service, `serve`, a hand-started backend) in one place; external clients keep working for the default install.
    - Cons: a user who deliberately ran their main install on a custom data directory loses the fixed port and must set it explicitly.
  - **Only `service install` changes: it writes `ORKESTRATOR_CONTROL_MCP_PORT=0` for a non-default data directory.**
    - Pros: smallest change; no backend behaviour change.
    - Cons: misses `serve` and hand-started backends; units installed by older CLIs keep the bug.
  - **Publish only (descriptor and Settings), no port change.**
    - Pros: users can find the conflict.
    - Cons: does not stop the takeover, which is the user-visible failure.
- **Should the Control MCP endpoint be published in `backend-instance.json`?**
  - **Yes, as a separate field (URL and running state), alongside the port change (recommended).**
    - Pros: an ephemeral port is useless unless a client can discover it; Settings → Control MCP can read the same value.
    - Cons: widens the descriptor contract in `packages/protocol`, which counts as a wide-reaching change for testing.
  - **No, keep it to stdout and Settings.**
    - Pros: no protocol change.
    - Cons: the CLI and other local clients cannot find a non-default endpoint.

### 2. Recover the port when it frees up

**Problem.** A backend that loses the bind runs without a Control MCP until restarted, even after the port frees.

**Context.** In the incident the port freed at 09:10:16, but the live backend never retried.

**Investigation.** `controlMcp.start()` is still called once, after recovery and initialisers, at `apps/backend/src/core/index.ts:1907`, and a failure is only logged. `getSettings()` already reports `running` and `error` (`control-mcp-server.ts:190`-`:193`), so Settings can show the failure, but not who holds the port.

**Decisions.**

- **How should a failed bind recover?**
  - **Retry with capped backoff (for example 5 s doubling to 5 min) while the port is the fixed default, and show "port in use" in Settings (recommended).**
    - Pros: self-heals the incident's 09:07 to 09:10 window; no user action.
    - Cons: a timer that must stop on shutdown and on an explicit disable; the credential publication ordering at `index.ts:1904` must hold for every retry.
  - **Offer a "Retry" button in Settings only.**
    - Pros: no background timer.
    - Cons: the user must notice first; external clients fail silently meanwhile.
- **Should Settings name the process holding the port?**
  - **No, only say the port is in use (recommended).**
    - Pros: no platform-specific process lookup; nothing about other processes leaks into the UI.
    - Cons: the user has to find the holder themselves.
  - **Yes, when the OS can tell (for example via `/proc` on Linux, `lsof` on macOS).**
    - Pros: faster diagnosis.
    - Cons: platform-specific, fragile, and close to the "never kill or inspect by port" practices this repository avoids.

### 3. Detect a second instance

**Problem.** Nothing tells a backend that another backend for the same user is already running, so it can collide on every fixed per-user resource, not only the Control MCP port.

**Context.** The file lists the Control MCP port, the loopback client port and the agent tools port.

**Investigation.** Each backend writes `backend-instance.json` in its own data directory (`packages/protocol/src/backend-instance.ts:12`). Reading the default data directory's descriptor from a non-default one is possible, but the descriptor alone does not prove liveness. If task 1's rule lands (only the default data directory binds the fixed ports), most of the collision risk is gone without detection.

**Decisions.**

- **Is a separate detection step needed?**
  - **Defer it until task 1 lands, then keep only a startup log line when the default data directory's descriptor names a live backend (recommended).**
    - Pros: task 1 removes the collision itself; the log helps diagnosis at little cost.
    - Cons: a hand-configured fixed port can still collide.
  - **Build full detection and avoidance of every fixed per-user resource now.**
    - Pros: covers custom configurations too.
    - Cons: needs a liveness check across data directories and a list of resources that must be kept current.

### 4. Find why the live backend exited at 00:58:57

**Problem.** The live backend died within a second of the second backend's restart, ending four worker sessions, and the mechanism is unknown.

**Context.** The file lists candidates (memory pressure, shared HOME state, tmux, Docker networks, Electron's handling of a backend exit) and asks why the app did not report the dead backend for eight hours.

**Investigation.** Part of this is now answered in `docs/debugging/process-crashes-and-kills.md` ("The 2026-10-26 incidents", `:180`-`:188`): the backend was SIGKILLed by an unknown sender while two full `mise run test` suites and the qualification service install were running inside the app; an audit trail (section 3 of that doc) was set up to catch the next one. The eight-hour freeze was `dialog.showErrorBox` blocking Electron's main process on Linux, replaced by the non-blocking `apps/desktop/electron/restart-prompt.ts` (#1301). The 09:05:47 SIGTRAP was `app.relaunch()` using the vanished AppImage mount (fixed in `apps/desktop/electron/relaunch.ts`), and the 09:11:12 SIGBUS is a network-service child outliving the main process on quit, documented as harmless. That answers this file's second open question and part of the first. What remains is whether the second backend's restart sent the SIGKILL or merely coincided with a test-suite kill, which this repository has seen before during agent-run `mise run test`.

**Decisions.**

- **How to pin down the sender?**
  - **Rely on the audit trail from `process-crashes-and-kills.md` on the next occurrence, and run the file's VM reproduction once without any test suite running (recommended).**
    - Pros: the VM run isolates the second-backend hypothesis from the test-suite one; the audit catches real-host recurrences.
    - Cons: needs a VM with a desktop backend; the real-host signal may take time to recur.
  - **Reproduce on the user's host.**
    - Pros: same environment as the incident.
    - Cons: forbidden by this file's constraints and the production-sharing rules in `AGENTS.md`.
- **Should the file's rating be revisited?**
  - **Keep High until task 1 is fully done, then re-rate (recommended).**
    - Pros: the default-port takeover is still reachable by a documented setup.
    - Cons: the scariest part (the exit) is no longer clearly caused by the second backend.
  - **Lower it now.**
    - Pros: reflects that the exit is attributed elsewhere.
    - Cons: a production-flavour second service still breaks the main install's Control MCP.

### 5. Qualify two backends on one host

**Problem.** No run has shown that two backends coexist after the fix.

**Context.** The run must happen in a VM or container, never on a machine someone works on; `scripts/qualify-standalone-service.ts` refuses to run when it finds another Orkestrator.

**Investigation.** The qualification script disables the Control MCP of its units, so as written it cannot prove task 1's behaviour for a production-flavour second service.

**Decisions.**

- **What should the run use for the second backend?**
  - **A production-flavour `orkestrator service install --data-dir <other>` with the Control MCP left enabled, in a disposable VM (recommended).**
    - Pros: exercises exactly the case that remains broken.
    - Cons: needs a VM image with a desktop or `serve` backend on the default data directory as well.
  - **`scripts/qualify-standalone-service.ts` as it is.**
    - Pros: already exists and is safe.
    - Cons: disables the Control MCP, so it proves nothing about the port.

Found 2026-10-26 on omarchy-hp (Arch/Omarchy Linux) during 0033's standalone
service qualification, against `main` at `93018933`.

A backend started for another data directory on the same host binds the
default Control MCP port, 34122, whenever it is free at that moment. It holds
the port until it exits. The live desktop install, relaunched in the
meantime, then runs with no Control MCP at all: `ControlMcpServer.start()` is
tried once during backend init and its failure is only logged. In the same run
the live backend exited within a second of the second backend's boot. Why is
not known yet.

## Current state

- `DEFAULT_CONTROL_MCP_PORT = 34122`
  ([`control-mcp-server.ts`](../../../apps/backend/src/core/control-mcp-server.ts)).
  Every backend uses it unless `ORKESTRATOR_CONTROL_MCP_PORT` is set or
  `ORKESTRATOR_CONTROL_MCP_DISABLED=1`. Nothing ties the port to the data
  directory, and the descriptor names no Control MCP endpoint.
- `OrkestratorBackend.init` calls `controlMcp.start()` once; a conflict logs
  `[backend] Failed to start control MCP: … Is port 34122 in use?` and is
  never retried
  ([`core/index.ts`](../../../apps/backend/src/core/index.ts), near the
  scheduled-jobs start).
- `orkestrator service install` writes a unit with only `PATH` and
  `NODE_ENV`, so a service for a second data directory inherits the user's
  HOME and the default Control MCP port. The CLI documents a second data
  directory as supported: its unit name carries the directory's digest
  ([`service-units.ts`](../../../packages/cli/src/client/service-units.ts)).
- The startup orphan reaper only signals PIDs recorded on its own data
  directory's environment records
  ([`local-server-reaper.ts`](../../../apps/backend/src/core/local-server-reaper.ts)),
  so it is not the mechanism below.

### Evidence (2026-10-26, UTC)

The live instance was the AppImage (`~/AppImages/orkestratorv2.appimage`,
unchanged since 00:17), backend on 127.0.0.1:34121 with Control MCP on
34122. The test services were `orkestrator@2.30.0-beta` from npm, installed
with `service install` into `/tmp` data directories, `--host 127.0.0.1
--allow-non-tailscale-bind --port <free> --runtime-flavor agent-test`, with
the user's real HOME.

| Time | What happened |
| --- | --- |
| 00:56:26 | First test unit (`orkestrator-backend-55889427`) loaded. The user manager logged `-.slice: The kernel OOM killer killed some processes in this unit.` The kernel log was not readable without root, so which process is unknown. That unit then crash-looped on a gateway bind refusal and was removed at 00:58:00. |
| 00:58:46 | Second test unit (`orkestrator-backend-cc7cd67b`) started. Its first boot logged `[backend] Failed to start control MCP: warn: Failed to start server. Is port 34122 in use?`, because the live backend held it. |
| 00:58:52 | The test restarted that unit (`systemctl --user restart`) to change its environment. |
| 00:58:57.05 | systemd started the unit's second boot. |
| 00:58:57.948 | Live Electron main: `ERROR [BackendClient] Event stream disconnected: TypeError: terminated … SocketError: other side closed` (remote 127.0.0.1:40463, the live backend). The live backend logged nothing after 00:58:37. |
| 00:58:59 | The test backend was ready. This boot logged no Control MCP failure, and it held 127.0.0.1:34122 from then on. |
| 00:58–09:05 | The live app ran with no backend. Four Claude worker sessions on the host stopped. |
| 09:05:37 | Live app: `Error occurred in handler for 'orkestrator:invoke': [TypeError: fetch failed] … ECONNRESET`. |
| 09:05:47 | The live Electron process dumped core with SIGTRAP (`coredumpctl`); the app was relaunched at 09:07. |
| 09:07–09:10 | The relaunched live backend listened on 34121 only: the test backend (pid 922010) still held 34122, so the live Control MCP never started. |
| 09:10:16 | The test unit was removed (`service uninstall --purge`), freeing 34122. |
| 09:11:12 | The live app's NetworkService child (pid 991601) dumped core with SIGBUS; the app restarted from a new mount and its backend then held 34121 and 34122 again. The AppImage file, `/tmp` (6%) and `/dev/shm` (1%) gave no reason for a SIGBUS. A separate crash investigation (codex) was running on the host at the time. |

## Outstanding work

### Code

1. **Keep a second backend off the default Control MCP port.** Options, best
   first:
   - Bind 34122 only for the platform default data directory (or the one
     the desktop app owns). Any other data directory takes an ephemeral
     port, or a configured one, and publishes it.
   - Publish the Control MCP endpoint (port, and whether it is running) in
     `backend-instance.json` and in Settings → Control MCP, so clients and
     the user can find a non-default port.
   - `service install` for a non-default data directory writes
     `ORKESTRATOR_CONTROL_MCP_PORT=0` (or disabled) into the unit unless
     the user passes one.
2. **Recover the port when it frees up.** A backend whose Control MCP lost
   the bind retries with backoff, and Settings shows the conflict and which
   process holds the port when it can tell.
3. **Detect a second instance.** At startup, read the default data
   directory's descriptor; if another live backend for this user exists,
   log it and avoid every other well-known per-user resource it uses
   (Control MCP port, loopback client port, agent tools port).
4. **Find why the live backend exited at 00:58:57.** Reproduce in a VM or
   container: a desktop (or `serve`) backend on the default data directory,
   then `service install` a second data directory and restart its unit, with
   the live backend's stdout and exit status captured. Candidates to rule
   out: memory pressure (the 00:56 OOM), anything the second backend touches
   under the shared HOME (`~/.claude.json`, `~/.codex`, the tmux server,
   Docker probe networks — Docker's address pools were exhausted at the
   time), and the Electron main's handling of a backend that exits without
   a restart. Also check why the live app did not restart or report its
   backend for eight hours.

### Qualification

5. Two backends on one host, in a VM or container: the default install keeps
   its Control MCP across a restart of either; the second publishes its own
   port; neither exits when the other boots, restarts or stops.

## Constraints and rationale

- Live runs of this kind must not happen on a machine someone works on.
  `scripts/qualify-standalone-service.ts` now refuses to run when it finds
  another Orkestrator, gives its units a private HOME, and disables their
  Control MCP before the first boot.
- External MCP clients are configured with `http://127.0.0.1:34122/…`. The
  default install must keep that port; only other data directories should
  move.

## Open questions

- Was the live backend's exit at 00:58:57 caused by the second backend's
  boot, or by the earlier OOM or something else on the host? The timing
  points at the boot (under one second), but no mechanism is identified.
- Was the 09:11 SIGBUS related to the test unit stopping at 09:10:16? No
  mechanism is known.

## Related

- [0033-remote-host-upgrades.md](0033-remote-host-upgrades.md): the
  qualification that found it.
- [control-mcp.md](../../architecture/control-mcp.md),
  [host-updates.md](../../architecture/host-updates.md#standalone-service).

## Replaces

Nothing; new on 2026-10-26.
