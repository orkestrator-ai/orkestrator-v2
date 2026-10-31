# A second backend on the same host takes the live one's Control MCP port

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e5` (first analysed 2026-10-27
against `863b5782`; tasks 1 to 3 were implemented on the
`todo-0244-second-backend-one-host` branch the same day).

### Tasks

1. **Keep a second backend off the default Control MCP port**: only the default data directory's backend binds 34122; every other one takes an ephemeral port and publishes it in `backend-instance.json`. Status: done (live proof is task 5).
2. **Recover the port when it frees up**: retry a failed bind of the fixed port with capped backoff and say "port in use" in Settings. Status: done (live proof is task 5).
3. **Detect a second instance**: a backend of another data directory logs a line when the default data directory's descriptor names a live backend. Status: done.
4. **Find why the live backend exited at 00:58:57**: reproduce in a VM without any test suite running. Status: open (needs a disposable VM; steps under Outstanding work).
5. **Qualify two backends on one host**: in a VM, neither loses its Control MCP or exits when the other boots, restarts or stops. Status: open (needs a disposable VM; steps under Outstanding work).

### 1. Keep a second backend off the default Control MCP port

**Problem.** Any backend bound `127.0.0.1:34122` if it was free when it started, so a service for a second data directory could take the port the user's external MCP clients are configured for, and the desktop app came up with no Control MCP.

**Context.** Found during [0033](0033-remote-host-upgrades.md)'s standalone service qualification. The CLI supports a second data directory with its own unit (`serviceUnitSuffix`, `packages/cli/src/client/service-units.ts:20`). Constraint: the default install must keep 34122.

**Investigation.** On `main` at `cd7bbe3e5`, `controlMcpPortOverride` (`apps/backend/src/core/control-mcp-server.ts:103`) gave port 0 only to `--runtime-flavor agent-test` backends (#1301) and `NODE_ENV=test`; a production- or development-flavour backend of any data directory still asked for 34122, and `orkestrator service install --data-dir <other>` writes only `PATH` and `NODE_ENV` into the unit. The desktop's production data directory is `app.getPath("appData")/orkestrator-v2` (`apps/desktop/electron/main.ts:207`, `app-constants.ts:11`), which is exactly `defaultDataDir()` (`apps/backend/src/data-dir.ts`) on macOS and Linux; `mise run dev` uses `orkestrator-v2-dev`. The data directory already had `control-mcp.json` with the URL, but it holds the credentials and keeps a stale URL after a failed bind, so it is no discovery file. Done on this branch: `isDefaultDataDir` (`apps/backend/src/data-dir.ts`) compares real paths; `controlMcpPortOverride(flavor, env, defaultDataDir)` returns 0 for any non-default data directory unless `ORKESTRATOR_CONTROL_MCP_PORT` is set (`apps/backend/src/core/index.ts`, the `ControlMcpServer` construction); `backend-instance.json` gains `controlMcp: { running, url? }` (`packages/protocol/src/backend-instance.ts`), republished on every listener change (`apps/backend/src/main.ts`, `publishCurrentInstanceDescriptor`). Tests: `apps/backend/src/core/control-mcp-port.test.ts`, `apps/backend/src/data-dir.test.ts`, `apps/backend/src/instance-descriptor.test.ts`.

**Decisions.**

- **Which backend may bind 34122?**
  - **Only a backend whose data directory resolves to `defaultDataDir()`; any other defaults to an ephemeral port unless `ORKESTRATOR_CONTROL_MCP_PORT` is set (recommended, implemented).**
    - Pros: fixes every second-instance path (service, `serve`, a hand-started backend, `mise run dev`) in one place; external clients keep working for the default install.
    - Cons: a user who deliberately ran their main install on a custom data directory loses the fixed port and must set it explicitly.
  - **Only `service install` changes: it writes `ORKESTRATOR_CONTROL_MCP_PORT=0` for a non-default data directory.**
    - Pros: smallest change; no backend behaviour change.
    - Cons: misses `serve` and hand-started backends; units installed by older CLIs keep the bug.
  - **Publish only (descriptor and Settings), no port change.**
    - Pros: users can find the conflict.
    - Cons: does not stop the takeover, which is the user-visible failure.
- **Should the Control MCP endpoint be published in `backend-instance.json`?**
  - **Yes, as a separate field (URL and running state), alongside the port change (recommended, implemented).**
    - Pros: an ephemeral port is useless unless a client can discover it; Settings → MCP reads the same state.
    - Cons: widens the descriptor contract in `packages/protocol`, which counts as a wide-reaching change for testing.
  - **No, keep it to stdout and Settings.**
    - Pros: no protocol change.
    - Cons: the CLI and other local clients cannot find a non-default endpoint.

### 2. Recover the port when it frees up

**Problem.** A backend that lost the bind ran without a Control MCP until restarted, even after the port freed.

**Context.** In the incident the port freed at 09:10:16, but the live backend never retried.

**Investigation.** `controlMcp.start()` is called once, after recovery and initialisers (`apps/backend/src/core/index.ts`, "Failed to start control MCP"), and Settings → MCP already shows `getSettings().error` in an amber "could not start" box (`apps/web/src/components/settings/McpSettings.tsx`). Done on this branch: `ControlMcpServer.start()` still rejects on the first failure (so the existing log line stays), but when the port is fixed and the error is `EADDRINUSE` (or Bun's "Is port N in use?") it schedules a retry, 5 s doubling to 5 min, until a bind succeeds or `stop()` runs. Every retry goes through the same `start` body, so the credential publication after `listen` (`credentials.flush(true)`) holds for it too, and it runs after the startup initialisers because the first attempt does. The error reads "Port 34122 is in use by another process. Orkestrator keeps retrying and starts the local MCP server once the port is free." A recovered listener logs `[control-mcp] Port N is free again; listening.`, re-reserves its port against previews, and republishes the descriptor. An ephemeral port is never retried.

**Decisions.**

- **How should a failed bind recover?**
  - **Retry with capped backoff (5 s doubling to 5 min) while the port is fixed, and show "port in use" in Settings (recommended, implemented).**
    - Pros: self-heals the incident's 09:07 to 09:10 window; no user action.
    - Cons: a timer that must stop on shutdown; `stop()` clears it and a retry that fails after `stop()` does not reschedule.
  - **Offer a "Retry" button in Settings only.**
    - Pros: no background timer.
    - Cons: the user must notice first; external clients fail silently meanwhile.
- **Should Settings name the process holding the port?**
  - **No, only say the port is in use (recommended, implemented).**
    - Pros: no platform-specific process lookup; nothing about other processes leaks into the UI.
    - Cons: the user has to find the holder themselves.
  - **Yes, when the OS can tell (for example via `/proc` on Linux, `lsof` on macOS).**
    - Pros: faster diagnosis.
    - Cons: platform-specific, fragile, and close to the "never kill or inspect by port" practices this repository avoids.

### 3. Detect a second instance

**Problem.** Nothing told a backend that another backend for the same user was already running.

**Context.** The original file listed the Control MCP port, the loopback client port and the agent tools port as shared per-user resources.

**Investigation.** With task 1 in place, only the default data directory binds the fixed Control MCP port. The agent tools server already falls back to an ephemeral port when its preferred one is taken (`apps/backend/src/core/agent-tools.ts`, `listen(preferredPort)` then `listen(0)`), and the loopback client port is opt-in (`--loopback-client-port`). The gateway's own default 34121 (`DEFAULT_GATEWAY_PORT`, `apps/backend/src/gateway-support-core.ts`) applies only when `--port` is omitted; `service install` and the desktop pass one. Done on this branch: `liveInstanceIn` (`apps/backend/src/instance-descriptor.ts`) reads another data directory's descriptor and checks the PID with signal 0 (EPERM counts as alive); `main.ts` calls it for `defaultDataDir()` when its own data directory is not the default, and logs `[Backend] Another backend (pid N) serves the default data directory; this one serves <dir> and leaves the fixed Control MCP port to it.` Seen in the isolated live check below.

**Decisions.**

- **Is a separate detection step needed?**
  - **Defer full detection; keep only a startup log line when the default data directory's descriptor names a live backend (recommended, implemented).**
    - Pros: task 1 removes the collision itself; the log helps diagnosis at little cost.
    - Cons: a hand-configured fixed port can still collide; a reused PID behind a stale descriptor can give a false log line.
  - **Build full detection and avoidance of every fixed per-user resource now.**
    - Pros: covers custom configurations too.
    - Cons: needs a liveness check across data directories and a list of resources that must be kept current.

### 4. Find why the live backend exited at 00:58:57

**Problem.** The live backend died within a second of the second backend's restart, ending four worker sessions, and the mechanism is unknown.

**Context.** The original file listed candidates (memory pressure, shared HOME state, tmux, Docker networks, Electron's handling of a backend exit) and asked why the app did not report the dead backend for eight hours.

**Investigation.** `docs/debugging/process-crashes-and-kills.md` ("The 2026-10-26 incidents") records it as a SIGKILL from an unknown sender while two full `mise run test` suites and the qualification service install were running inside the app; its section 3 sets up an audit trail for the next one. The eight-hour freeze was `dialog.showErrorBox` blocking Electron's main process on Linux, replaced by the non-blocking `apps/desktop/electron/restart-prompt.ts` (#1301). The 09:05:47 SIGTRAP was `app.relaunch()` using the vanished AppImage mount (fixed in `apps/desktop/electron/relaunch.ts`), and the 09:11:12 SIGBUS is a network-service child outliving the main process on quit, documented as harmless. What remains is whether the second backend's restart sent the SIGKILL or merely coincided with a test-suite kill, which this repository has seen before during agent-run `mise run test`. Nothing on this branch changes that; it can only be settled by the VM run under Outstanding work.

**Decisions.**

- **How to pin down the sender?**
  - **Rely on the audit trail from `process-crashes-and-kills.md` on the next occurrence, and run the VM reproduction once without any test suite running (recommended).**
    - Pros: the VM run isolates the second-backend hypothesis from the test-suite one; the audit catches real-host recurrences.
    - Cons: needs a VM with a desktop backend; the real-host signal may take time to recur.
  - **Reproduce on the user's host.**
    - Pros: same environment as the incident.
    - Cons: forbidden by this file's constraints and the production-sharing rules in `AGENTS.md`.
- **Should the file's rating be revisited?**
  - **Keep High until task 1 is fully done, then re-rate (recommended).**
    - Pros: the default-port takeover is still reachable until the fix ships and is proved.
    - Cons: the scariest part (the exit) is no longer clearly caused by the second backend.
  - **Lower it now.**
    - Pros: reflects that the exit is attributed elsewhere.
    - Cons: the new port rule and retry are on by default and not yet proved on a real install.

### 5. Qualify two backends on one host

**Problem.** No run has shown that two backends coexist after the fix.

**Context.** The run must happen in a VM or container, never on a machine someone works on; `scripts/qualify-standalone-service.ts` refuses to run when it finds another Orkestrator.

**Investigation.** The qualification script disables the Control MCP of its units, so as written it cannot prove task 1's behaviour for a production-flavour second service. On this branch the rule, retry and descriptor field are proved by unit tests with OS-assigned ports and by one isolated `agent-test` backend in throwaway directories (Assumptions and decisions, "Tasks 1 to 3: how the behaviour was proved"). Neither binds 34122 or runs a production-flavour backend, so the default install keeping 34122 across the other's restarts is still unobserved.

**Decisions.**

- **What should the run use for the second backend?**
  - **A production-flavour `orkestrator service install --data-dir <other>` with the Control MCP left enabled, in a disposable VM (recommended).**
    - Pros: exercises exactly the case that was broken.
    - Cons: needs a VM image with a desktop or `serve` backend on the default data directory as well.
  - **`scripts/qualify-standalone-service.ts` as it is.**
    - Pros: already exists and is safe.
    - Cons: disables the Control MCP, so it proves nothing about the port.

## Assumptions and decisions

### Task 1: the recommended port rule stands

Chose the recommended rule: only the default data directory's backend binds
34122. The code confirmed it is right: the desktop's production data directory
is built from Electron's `appData` and the same `orkestrator-v2` slug, which is
what `defaultDataDir()` returns on both supported platforms, so the installed
app keeps the port without a flag. `isDefaultDataDir` compares real paths, so
a symlink to the default still counts.

### Task 1: `mise run dev` moves too

A `mise run dev` backend (data directory `orkestrator-v2-dev`) now also takes
an ephemeral Control MCP port. That is intended: a development backend must
not take the installed app's port either, and the agent rules forbid binding
34122 from a worktree. A developer who needs the fixed port sets
`ORKESTRATOR_CONTROL_MCP_PORT`.

### Task 1: an explicit port still wins

`ORKESTRATOR_CONTROL_MCP_PORT` beats both the agent-test and the
non-default-directory rule (outside `NODE_ENV=test`), matching the existing
agent-test behaviour, so a user who runs their main install on a custom
directory can keep 34122.

### Task 1: no change to `service install`

The CLI's unit writer is unchanged: the backend now decides, which also
covers units written by older CLIs. Known edge: on Linux, a CLI run with a
non-standard `XDG_CONFIG_HOME` computes its default data directory from it, but
the systemd unit does not pass `XDG_CONFIG_HOME` on, so that unit's backend
would count its directory as non-default and take an ephemeral port (published
in the descriptor). Left as is; it needs a user who both sets
`XDG_CONFIG_HOME` and relies on 34122 for a standalone service.

### Task 1: descriptor field shape

`controlMcp` is `{ running: boolean, url?: string }`, omitted when the Control
MCP is disabled. `url` is the bound listener when running, the fixed URL
being retried when not, and absent for an ephemeral port that has not bound.
It is optional and additive, so older clients and older descriptors still
parse. The descriptor is rewritten on every listener change through one
serialized writer that stops before shutdown removes the file, so a late
change cannot recreate a removed descriptor.

### Task 2: retry details

Backoff 5 s doubling to 5 min, no attempt cap, only for a fixed port and only
for "address in use" (other bind errors are not retried). `start()` keeps
rejecting on the first failure so the existing startup log stays. Settings
shows the new error text in the existing amber box; no UI change was needed,
and Settings does not name the holder (recommended option).

### Task 3: liveness by signal 0

The log line checks the default descriptor's PID with `process.kill(pid, 0)`,
which delivers no signal. It is a read, not a kill, so it is inside the
repository's "signal only what you spawned" rule. The unit test checks the
default checker against a `sleep` it spawned and stops through its own handle.

### Task 4: rating kept at High

Took the recommended "keep High until task 1 is fully done". Task 1 is done
in code but the new rule and the retry are on by default and not yet proved on
a real install (task 5), and the exit's sender is still unknown, which is the
"never proved on the real stack" case of the High rating. Re-rate after the
task 5 run.

### Tasks 1 to 3: how the behaviour was proved

Only with unit tests and one isolated backend, as the work order required:
nothing ran against the real data directory, bound 34121 or 34122, or made a
provider turn.

- `control-mcp-port.test.ts` holds a loopback port the OS assigned with a
  plain TCP server, starts a `ControlMcpServer` on that port as its "fixed"
  port, and checks: the first start rejects, Settings says the port is in use,
  the endpoint state names the URL with `running: false`, retries stay silent,
  the listener binds after the holder closes (unauthenticated POST answers
  401), state listeners see false then true, and `stop()` cancels a pending
  retry.
- An isolated `--runtime-flavor agent-test` backend (`apps/backend/src/main.ts`,
  `--port 0 --control-port 0`, throwaway `HOME`, data directory, worktree
  directory and `TMUX_TMPDIR`, `DOCKER_HOST` pointing at a missing socket,
  host-reachability probe off) with a planted default-directory descriptor
  naming a `sleep` the script spawned. Observed on 2026-10-30: the
  second-instance log line, `controlMcp: {"running":true,"url":"http://127.0.0.1:56590/mcp"}`
  in its descriptor (an OS-assigned port), 401 from that URL without a token,
  exit 0 on SIGTERM, and the descriptor removed on shutdown. A
  production-flavour backend was not started: outside `agent-test` it can
  refresh host agent logins and Keychain entries, which the work order
  forbids touching.

## Current state

- Only the default data directory's backend binds 34122
  ([`control-mcp-server.ts`](../../../apps/backend/src/core/control-mcp-server.ts),
  `controlMcpPortOverride`; [`data-dir.ts`](../../../apps/backend/src/data-dir.ts),
  `isDefaultDataDir`). Every other backend, and every `agent-test` or test
  backend, takes an ephemeral port unless `ORKESTRATOR_CONTROL_MCP_PORT` is
  set.
- `backend-instance.json` carries `controlMcp: { running, url? }` and is
  rewritten when the listener starts, stops or fails to bind
  ([`backend-instance.ts`](../../../packages/protocol/src/backend-instance.ts),
  [`main.ts`](../../../apps/backend/src/main.ts)).
- A taken fixed port is retried with backoff (5 s to 5 min) and Settings → MCP
  says the port is in use.
- A backend of another data directory logs when the default data directory's
  descriptor names a live backend.
- `orkestrator service install` still writes only `PATH` and `NODE_ENV`; the
  backend's rule covers its units, including ones written by older CLIs.
- The startup orphan reaper only signals PIDs recorded on its own data
  directory's environment records
  ([`local-server-reaper.ts`](../../../apps/backend/src/core/local-server-reaper.ts)),
  so it is not the mechanism of the 00:58:57 exit.

Found 2026-10-26 on omarchy-hp (Arch/Omarchy Linux) during 0033's standalone
service qualification, against `main` at `93018933`.

A backend started for another data directory on the same host binds the
default Control MCP port, 34122, whenever it is free at that moment. It holds
the port until it exits. The live desktop install, relaunched in the
meantime, then runs with no Control MCP at all: `ControlMcpServer.start()` is
tried once during backend init and its failure is only logged. In the same run
the live backend exited within a second of the second backend's boot. Why is
not known yet.

### Incident evidence (2026-10-26, UTC)

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

### Qualification

Both runs need a disposable Linux VM (for example Ubuntu 24.04 with a desktop
session for task 4) with Docker, `bun`, `jq` and `ss`, and a build that
contains this branch (an `orkestrator` CLI from a release cut after it merges,
or `bun pm pack` of `packages/cli` installed with `bunx`). Never on a machine
someone works on.

4. **The 00:58:57 exit.** In the VM, with no test suite running:
   1. Turn on the signal audit from
      [`process-crashes-and-kills.md`](../../debugging/process-crashes-and-kills.md)
      section 3 (`ork-audit-on.sh`).
   2. Start the desktop AppImage on the default data directory and open one
      local environment with a running agent tab. Record the backend PID
      (`jq .pid ~/.config/orkestrator-v2/backend-instance.json`).
   3. Reproduce the incident's second unit with the pre-fix CLI:
      `bunx orkestrator@2.30.0-beta service install --data-dir /tmp/ork-b
      --host 127.0.0.1 --allow-non-tailscale-bind --port 0 --runtime-flavor
      agent-test --yes`, then `systemctl --user restart
      orkestrator-backend-<digest>.service` three times, 20 s apart.
   4. Pass: the desktop backend's PID is unchanged, `journalctl --user` and
      `coredumpctl` show nothing for it, and the audit log shows no SIGKILL to
      it. If it dies, the audit log names the sender; record it here.
   5. Clean up with `service uninstall --data-dir /tmp/ork-b --purge` and
      `ork-audit-off.sh`.
5. **Two backends on one host.** In the VM, with the new build:
   1. Backend A on the default data directory: `orkestrator service install
      --yes` (or the desktop app). Check `ss -ltnp 'sport = :34122'` names A's
      PID and `jq .controlMcp ~/.config/orkestrator-v2/backend-instance.json`
      is `{"running":true,"url":"http://127.0.0.1:34122/mcp"}`.
   2. Backend B, production flavour, Control MCP enabled: `orkestrator service
      install --data-dir /var/tmp/ork-b --yes`. Check B's
      `/var/tmp/ork-b/backend-instance.json` `controlMcp.url` is not on 34122,
      B's `service.log` has the "Another backend (pid …) serves the default
      data directory" line, and A still holds 34122.
   3. Restart B's unit three times. A's PID is unchanged, A's
      `http://127.0.0.1:34122/mcp` answers 401 without a token, and B never
      holds 34122.
   4. Retry: stop A's unit, hold the port with a process you start
      (`python3 -m http.server 34122 --bind 127.0.0.1 &`, note its PID), start
      A. A's descriptor shows `"running":false` and Settings → MCP (or the
      `get_control_mcp_settings` command) says port 34122 is in use. Stop the
      Python server by its recorded PID; within 5 min A logs
      `[control-mcp] Port 34122 is free again; listening.` and its descriptor
      shows `"running":true`.
   5. Stop and uninstall B (`service uninstall --data-dir /var/tmp/ork-b
      --purge`); A is unaffected. Restart A; it binds 34122 again.
   6. Record the commands' output here and re-rate the file.

## Constraints and rationale

- Live runs of this kind must not happen on a machine someone works on.
  `scripts/qualify-standalone-service.ts` refuses to run when it finds another
  Orkestrator, gives its units a private HOME, and disables their Control MCP
  before the first boot.
- External MCP clients are configured with `http://127.0.0.1:34122/…`. The
  default install must keep that port; only other data directories move.

## Open questions

- Was the live backend's exit at 00:58:57 caused by the second backend's
  boot, or by the earlier OOM or something else on the host? The timing
  points at the boot (under one second), but no mechanism is identified
  (task 4).

## Related

- [0033-remote-host-upgrades.md](0033-remote-host-upgrades.md): the
  qualification that found it.
- [control-mcp.md](../../architecture/control-mcp.md),
  [public-cli.md](../../architecture/public-cli.md#instance-descriptor),
  [host-updates.md](../../architecture/host-updates.md#standalone-service),
  [process-crashes-and-kills.md](../../debugging/process-crashes-and-kills.md).

## Replaces

Nothing; new on 2026-10-26.
