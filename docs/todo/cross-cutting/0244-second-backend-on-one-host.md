# A second backend on the same host takes the live one's Control MCP port

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
