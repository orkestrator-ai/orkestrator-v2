# A second backend can take the desktop's gateway port 34121

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e5`, while working on
[0244](0244-second-backend-on-one-host.md).

### Tasks

1. **Keep a second backend off the default gateway port**: decide which backend may default to 34121 and what every other one does when `--port` is omitted. Status: open.
2. **Stop the desktop's gateway falling back onto 34122**: the desktop's own gateway fallback can land on the Control MCP's fixed port. Status: open.
3. **Qualify**: in a disposable VM, a second service started before the desktop leaves the desktop's 34121 and 34122 alone. Status: open (depends on 1 and 2).

### 1. Keep a second backend off the default gateway port

**Problem.** A backend started without `--port` asks for the default gateway port 34121, whatever its data directory. A service for a second data directory that starts before the desktop app (a systemd user unit or LaunchAgent at login, say) takes 34121, and the desktop's gateway then falls back to the next free port.

**Context.** 0244 fixed the same takeover for the Control MCP port (only the default data directory's backend binds 34122). The gateway default is `DEFAULT_GATEWAY_PORT = 34121` (`apps/backend/src/gateway-support-core.ts:198`), used in `GatewayLifecycle` when neither `--port` nor `ORKESTRATOR_GATEWAY_PORT` is given (`apps/backend/src/gateway-lifecycle.ts:81`). `orkestrator service install` never adds `--port` (`packages/cli/src/client/service-setup.ts`, `askServeArguments`), so every service, for any data directory, asks for 34121. Remote machines are added in the desktop by their address on 34121, so the default install of a remote host must keep it.

**Investigation.** Unlike the Control MCP, the gateway already survives a taken port: `listenWithPortFallback` (`gateway-lifecycle.ts:169`) tries the next 1 to N ports and then an ephemeral one, unless `--strict-gateway-port` is set. So a second backend does not fail; it moves whichever backend starts second. The CLI and desktop find a backend through `backend-instance.json` and connection records, not the fixed port, for local use; remote use over Tailscale relies on 34121.

**Decisions.**

- **Which backend may default to 34121?**
  - **Only the default data directory's backend; any other one defaults to an ephemeral port unless `--port` or `ORKESTRATOR_GATEWAY_PORT` is given, and `service install --data-dir <other>` prints the port it got (recommended).**
    - Pros: the same rule as the Control MCP (`isDefaultDataDir`); a second service can never move the main install.
    - Cons: a remote second service over Tailscale needs an explicit `--port` to have a stable address; the setup flow has to say so.
  - **`service install` writes `--port 0` for a non-default data directory.**
    - Pros: smallest change; no backend behaviour change.
    - Cons: misses `serve` and hand-started backends, and units written by older CLIs.
  - **Leave it; the fallback already keeps both running.**
    - Pros: no change.
    - Cons: the main install's address changes depending on start order, and task 2's collision stays reachable.

### 2. Stop the desktop's gateway falling back onto 34122

**Problem.** The production desktop starts its backend with `--port 34121` and no `--strict-gateway-port` (`apps/desktop/electron/backend-process.ts`, `launch`; `main.ts` sets `strictGatewayPort` only for agent-test). If 34121 is taken, the first fallback candidate is 34122, which is the desktop backend's own Control MCP port. Its gateway then holds 34122, and its Control MCP retries the bind for ever (0244 task 2) with "Port 34122 is in use by another process" in Settings.

**Context.** Found reading `listenWithPortFallback` while implementing 0244's retry. Not observed live.

**Investigation.** The fallback walks `preferredPort + offset` for `GATEWAY_PORT_FALLBACK_ATTEMPTS` ports. Nothing skips ports another listener of the same backend needs.

**Decisions.**

- **How to keep the gateway off 34122?**
  - **Skip the fixed Control MCP port (and the loopback client port when set) in the fallback walk (recommended).**
    - Pros: a few lines in one place; keeps the fallback for everything else.
    - Cons: the skip list must follow any new fixed port.
  - **Fall back straight to an ephemeral port.**
    - Pros: never collides with a fixed port.
    - Cons: the nearby-port behaviour some users may rely on goes away.

### 3. Qualify

**Problem.** Neither fix is proved on a real install.

**Context.** Same constraints as 0244: never on a machine someone works on.

**Investigation.** In a disposable Linux VM: `orkestrator service install --data-dir /var/tmp/ork-b --yes` (it starts at once), then start the desktop app (or `orkestrator service install --yes` for the default data directory). Before the fix, expect B on 34121 and the main backend's gateway on 34122 with its Control MCP failing (`ss -ltnp`, `jq . ~/.config/orkestrator-v2/backend-instance.json`). After it, the main backend holds 34121 and 34122 and B is on an ephemeral port named in `/var/tmp/ork-b/backend-instance.json`.

**Decisions.**

- **Where to run it?**
  - **In the same VM run as 0244 task 5 (recommended).**
    - Pros: one VM image, one set of steps.
    - Cons: that run grows by one start-order case.
  - **A separate run.**
    - Pros: independent of 0244's schedule.
    - Cons: duplicates the VM setup.

## Constraints and rationale

- The default install keeps 34121 and 34122: remote machines are reached on
  34121 and external MCP clients on 34122.
- Agents must never bind 34121 or 34122, or run a backend against the real data
  directory; prove this with unit tests and isolated backends on OS-assigned
  ports, and the VM run.

## Related

- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md):
  the Control MCP half of the same problem.
- [remote-gateway.md](../../architecture/remote-gateway.md),
  [control-mcp.md](../../architecture/control-mcp.md).

## Replaces

Nothing; new on 2026-10-30.
